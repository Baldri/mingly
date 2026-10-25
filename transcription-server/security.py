"""Authentication and audio-path confinement for the transcription service.

Kept separate from `server.py` for the same reason Mingly keeps
`src/main/server/api-auth.ts` separate: the rules are pure functions, so they
can be unit-tested without booting a server, and they read as one page.

Two things this file exists to prevent:

1. **Arbitrary file read.** `POST /transcribe` takes a path and
   `GET /jobs/{id}` returns the resulting text. Without confinement that pair
   transcribes any audio file on the host and hands back the transcript — and
   a localhost service is reachable from a web page via DNS rebinding. For a
   product whose selling point is confidentiality that is not acceptable, so
   submitted paths must resolve inside one configured spool directory.
2. **An unauthenticated service on the network.** Binding to a non-loopback
   address without a key would expose exactly the capability above to anyone
   who can reach the port, so that combination refuses to start.
"""

import hmac
import ipaddress
import logging
from collections.abc import Iterable
from pathlib import Path

logger = logging.getLogger(__name__)

_BEARER_PREFIX = "Bearer "

# Headers that mean something forwarded this request. Their presence alone
# disqualifies the peer address as evidence of an on-box caller; the values are
# never read. Add to this tuple to cover a further proxy convention.
FORWARDING_HEADERS = ("x-forwarded-for", "forwarded")


class AudioPathRejected(Exception):
    """A submitted audio path is not usable.

    The message is for the service log only. The HTTP layer must answer with
    one generic error: which check failed, and whether a given path exists, is
    information an unauthenticated caller should not be able to probe for.
    """


def is_loopback_host(host: str) -> bool:
    """Whether binding to `host` keeps the service off the network.

    "0.0.0.0" and "::" are NOT loopback: they are every interface, which is
    the case this check exists to catch.
    """
    candidate = host.strip().lower()
    if candidate == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        # An unparseable or empty host is treated as reachable: fail closed.
        return False


def auth_required(host: str, require_auth: bool) -> bool:
    """Whether a key must be presented.

    Auth is forced on for any non-loopback bind, regardless of the flag. An
    operator who puts this on a network interface must not be able to opt out
    of authentication, by configuration or by oversight.
    """
    return require_auth or not is_loopback_host(host)


def has_forwarding_header(header_names: Iterable[str]) -> bool:
    """Whether any proxy-forwarding header is present.

    Takes the header NAMES only, deliberately: the value of an
    `X-Forwarded-For` is supplied by whoever sent it, and the one thing this
    service must never do is believe it. Presence is the whole signal.
    """
    lowered = {name.lower() for name in header_names}
    return any(header in lowered for header in FORWARDING_HEADERS)


def auth_required_for_request(
    client_host: str | None, host: str, require_auth: bool, via_proxy: bool = False
) -> bool:
    """Whether THIS request has to present a key, judged from real state.

    `auth_required` alone reads the configured bind, and configuration can be
    wrong about reality: `uvicorn server:app --host 0.0.0.0` (or any ASGI
    runner with its own --host, or a container command) binds the network
    while TRANSCRIPTION_HOST still says 127.0.0.1. A configuration-only check
    would then wave through exactly the case it exists to stop.

    Measured on 2026-10-25: the ASGI scope does NOT carry the bind address —
    `scope["server"]` is the local address of the individual connection, so it
    reports 127.0.0.1 for a loopback request even when the server is bound to
    0.0.0.0. The peer address is therefore the available evidence, and a
    non-loopback peer is proof that the service is reachable off the box,
    whatever the configuration claims.

    The peer is only genuine transport state while nothing rewrites it.
    uvicorn's Config defaults to `proxy_headers=True`, and its
    ProxyHeadersMiddleware replaces `scope["client"]` with the address from
    `X-Forwarded-For` whenever the transport peer is trusted — and
    `FORWARDED_ALLOW_IPS=*`, which container guides hand out freely, trusts
    everyone. The service therefore passes `proxy_headers=False`, AND treats
    `via_proxy` (a forwarding header being present at all) as "not a direct
    on-box caller", so the guarantee does not rest on that one flag.
    """
    if auth_required(host, require_auth):
        return True
    if via_proxy:
        # Something forwarded this; the peer address is not evidence any more.
        return True
    if client_host is None:
        # No peer information: treat as remote rather than guess local.
        return True
    return not is_loopback_host(client_host)


def check_api_key(
    authorization: str | None, configured: str | None, require_auth: bool
) -> bool:
    """Compare a presented bearer token against the configured key.

    Fails CLOSED: when auth is required but no key is configured, this denies.
    Returning True there would turn a misconfiguration into an open service —
    the same trap Mingly's own `checkApiAuth` documents having fallen into.
    """
    if not require_auth:
        return True
    if not configured:
        return False
    if not authorization:
        return False

    token = authorization
    if token.startswith(_BEARER_PREFIX):
        token = token[len(_BEARER_PREFIX):]

    # Constant time: `==` on a secret leaks its prefix through timing.
    return hmac.compare_digest(token.encode("utf-8"), configured.encode("utf-8"))


def assert_auth_config(host: str, require_auth: bool, api_key: str | None) -> None:
    """Refuse to start rather than run reachable and unauthenticated."""
    if auth_required(host, require_auth) and not api_key:
        raise RuntimeError(
            f"Refusing to start: the service would listen on {host!r} with "
            "authentication required but no key configured, which would accept "
            "unauthenticated requests. Set TRANSCRIPTION_API_KEY, or bind to a "
            "loopback address and leave TRANSCRIPTION_REQUIRE_AUTH off."
        )


def allowed_hosts(host: str) -> list[str]:
    """Host header values to accept, for TrustedHostMiddleware.

    A Host allowlist is what stops DNS rebinding: a browser can be pointed at
    127.0.0.1 but it still sends the attacker's name in the Host header.
    """
    return sorted({host, "127.0.0.1", "localhost"})


def resolve_spool_path(audio_path: str, spool_root: Path) -> Path:
    """Resolve a submitted audio path, confined to the spool directory.

    A relative path is taken relative to the spool root. Everything else must
    resolve to a regular, non-empty file inside it.

    Raises:
        AudioPathRejected: for any path that is not usable, with the reason in
            the message for logging only.
    """
    try:
        return _resolve_spool_path(audio_path, spool_root)
    except AudioPathRejected:
        raise
    except (OSError, ValueError) as error:
        # pathlib raises ValueError on an embedded NUL byte and OSError on
        # various unusable names. Left unhandled these escape as a 500 with a
        # traceback, which fails the request AND says more about the internals
        # than the deliberately generic 400 is allowed to.
        raise AudioPathRejected(
            f"unusable path {audio_path!r}: {error!r}"
        ) from error


def _resolve_spool_path(audio_path: str, spool_root: Path) -> Path:
    root = spool_root.resolve()
    submitted = Path(audio_path)
    raw = submitted if submitted.is_absolute() else root / submitted

    # Checked before resolving: a symlink is refused outright, even when it
    # happens to point inside the spool. There is no reason for the caller to
    # hand us one, and allowing them means the target can be swapped between
    # this check and the read (a race we would rather not have to reason about).
    if raw.is_symlink():
        raise AudioPathRejected(f"path is a symlink: {audio_path!r}")

    resolved = raw.resolve()

    # `is_relative_to` on resolved paths, NOT a string prefix test: the latter
    # accepts "/spool-evil/x.wav" for the root "/spool".
    if resolved != root and not resolved.is_relative_to(root):
        raise AudioPathRejected(
            f"path resolves outside the spool directory: {audio_path!r} -> {resolved}"
        )

    if not resolved.is_file():
        raise AudioPathRejected(f"not a regular file: {audio_path!r}")

    if resolved.stat().st_size == 0:
        raise AudioPathRejected(f"file is empty: {audio_path!r}")

    return resolved
