"""Tests for authentication, audio-path confinement and the exposed surface.

Three ways of driving the service, each for a reason:

- Pure functions (`security.*`) for the decision logic — exhaustive and fast.
- A real uvicorn server over `urllib` for the wiring. `fastapi.testclient`
  needs `httpx`, which is deliberately not installed (Ruling 8), and an auth
  check that only works when called directly is not an auth check.
- The ASGI app called directly, where the peer address has to be chosen: a
  non-loopback client cannot be produced from a loopback socket.

Every server fixture is FUNCTION scoped. Module-scoped fixtures mutating the
same module globals used to overlap, so a test could silently run under the
other fixture's settings — the `_start` helper now asserts its own premise.
"""

import asyncio
import json
import queue
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Iterator

import pytest

import pipeline
import security
import server

TEST_KEY = "test-key-do-not-use-anywhere"
REMOTE_CLIENT = ("192.168.1.50", 41234)
LOCAL_CLIENT = ("127.0.0.1", 41234)


# --------------------------------------------------------------------------
# Path confinement
# --------------------------------------------------------------------------


@pytest.fixture
def spool(tmp_path: Path) -> Path:
    root = tmp_path / "spool"
    root.mkdir()
    return root


def test_akzeptiert_datei_im_spool(spool: Path) -> None:
    """Positive control for every rejection test below.

    A confinement check that rejected everything would satisfy all of them.
    """
    audio = spool / "meeting.wav"
    audio.write_bytes(b"RIFF-not-really-audio")
    assert security.resolve_spool_path(str(audio), spool) == audio.resolve()


def test_akzeptiert_relativen_pfad_im_spool(spool: Path) -> None:
    audio = spool / "meeting.wav"
    audio.write_bytes(b"RIFF-not-really-audio")
    assert security.resolve_spool_path("meeting.wav", spool) == audio.resolve()


def test_lehnt_pfad_ausserhalb_des_spools_ab(spool: Path, tmp_path: Path) -> None:
    outside = tmp_path / "confidential.wav"
    outside.write_bytes(b"RIFF-secret")
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(outside), spool)


def test_lehnt_praefix_nachbarverzeichnis_ab(tmp_path: Path) -> None:
    """A string prefix check would wave this through.

    `/…/spool-evil/x.wav` starts with `/…/spool` as text but is NOT inside it.
    """
    root = tmp_path / "spool"
    root.mkdir()
    sibling = tmp_path / "spool-evil"
    sibling.mkdir()
    audio = sibling / "x.wav"
    audio.write_bytes(b"RIFF")
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(audio), root)


def test_lehnt_traversierung_ab(spool: Path, tmp_path: Path) -> None:
    outside = tmp_path / "confidential.wav"
    outside.write_bytes(b"RIFF-secret")
    traversing = str(spool / ".." / "confidential.wav")
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(traversing, spool)


def test_lehnt_symlink_nach_draussen_ab(spool: Path, tmp_path: Path) -> None:
    outside = tmp_path / "confidential.wav"
    outside.write_bytes(b"RIFF-secret")
    link = spool / "innocent.wav"
    link.symlink_to(outside)
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(link), spool)


def test_lehnt_symlink_auch_innerhalb_ab(spool: Path) -> None:
    """Symlinks are refused outright, not only when they escape."""
    target = spool / "real.wav"
    target.write_bytes(b"RIFF")
    link = spool / "link.wav"
    link.symlink_to(target)
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(link), spool)


def test_lehnt_symlink_im_zwischenverzeichnis_ab(spool: Path, tmp_path: Path) -> None:
    """An escape through a symlinked parent directory component."""
    outside_dir = tmp_path / "secrets"
    outside_dir.mkdir()
    audio = outside_dir / "confidential.wav"
    audio.write_bytes(b"RIFF-secret")
    (spool / "innocent-dir").symlink_to(outside_dir, target_is_directory=True)
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(spool / "innocent-dir" / "confidential.wav"), spool)


def test_lehnt_leere_und_fehlende_datei_ab(spool: Path) -> None:
    empty = spool / "empty.wav"
    empty.write_bytes(b"")
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(empty), spool)
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(spool / "missing.wav"), spool)


def test_lehnt_verzeichnis_ab(spool: Path) -> None:
    subdir = spool / "a-directory"
    subdir.mkdir()
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path(str(subdir), spool)


def test_lehnt_nullbyte_als_abweisung_nicht_als_absturz_ab(spool: Path) -> None:
    """A NUL byte makes pathlib raise ValueError.

    Unhandled, that surfaces as a 500 with a traceback, which both crashes the
    request and says more about the internals than a generic 400 should.
    """
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path("a\0b.wav", spool)


def test_lehnt_uebergrossen_pfad_als_abweisung_ab(spool: Path) -> None:
    """An over-long name makes the OS raise OSError rather than returning False."""
    with pytest.raises(security.AudioPathRejected):
        security.resolve_spool_path("x" * 10_000 + ".wav", spool)


# --------------------------------------------------------------------------
# Key comparison, the startup guard, and per-request auth
# --------------------------------------------------------------------------


def test_erkennt_loopback_adressen() -> None:
    assert security.is_loopback_host("127.0.0.1")
    assert security.is_loopback_host("localhost")
    assert security.is_loopback_host("::1")
    assert security.is_loopback_host("127.0.0.2")
    # The ones that matter: these reach the network.
    assert not security.is_loopback_host("0.0.0.0")
    assert not security.is_loopback_host("")
    assert not security.is_loopback_host("192.168.1.10")
    assert not security.is_loopback_host("::")


def test_schluesselpruefung_faellt_geschlossen_aus() -> None:
    """Auth required but no key configured must DENY, never allow."""
    assert not security.check_api_key("Bearer anything", configured=None, require_auth=True)
    assert not security.check_api_key(None, configured=TEST_KEY, require_auth=True)
    assert not security.check_api_key("Bearer wrong", configured=TEST_KEY, require_auth=True)
    assert not security.check_api_key("", configured=TEST_KEY, require_auth=True)
    assert security.check_api_key(f"Bearer {TEST_KEY}", configured=TEST_KEY, require_auth=True)
    # A bare token without the "Bearer " prefix is accepted too, as Mingly's
    # own api-auth.ts does.
    assert security.check_api_key(TEST_KEY, configured=TEST_KEY, require_auth=True)


def test_auth_ist_auf_nicht_loopback_erzwungen_auch_ohne_flag() -> None:
    """An operator who binds to the network must not be able to opt out."""
    assert security.auth_required(host="0.0.0.0", require_auth=False)
    assert security.auth_required(host="192.168.1.10", require_auth=False)
    assert not security.auth_required(host="127.0.0.1", require_auth=False)
    assert security.auth_required(host="127.0.0.1", require_auth=True)


def test_auth_haengt_am_echten_gegenueber_nicht_nur_an_der_konfiguration() -> None:
    """The I2 case: an external runner binds the network, the env var does not say so.

    `uvicorn server:app --host 0.0.0.0` leaves TRANSCRIPTION_HOST at
    127.0.0.1, so a configuration-only check sees "loopback, no auth needed".
    The peer address is the state that cannot be faked away.
    """
    # Configured loopback, but the request comes from the network: auth needed.
    assert security.auth_required_for_request(
        client_host="192.168.1.50", host="127.0.0.1", require_auth=False
    )
    # A genuinely local request on the on-device default: no auth needed.
    assert not security.auth_required_for_request(
        client_host="127.0.0.1", host="127.0.0.1", require_auth=False
    )
    # An unknown peer is treated as remote: fail closed.
    assert security.auth_required_for_request(
        client_host=None, host="127.0.0.1", require_auth=False
    )
    # The configured bind alone still forces auth, whoever is calling.
    assert security.auth_required_for_request(
        client_host="127.0.0.1", host="0.0.0.0", require_auth=False
    )
    # And the explicit flag always wins.
    assert security.auth_required_for_request(
        client_host="127.0.0.1", host="127.0.0.1", require_auth=True
    )


def test_startpruefung_lehnt_netzbindung_ohne_schluessel_ab() -> None:
    with pytest.raises(RuntimeError, match="TRANSCRIPTION_API_KEY"):
        security.assert_auth_config(host="0.0.0.0", require_auth=False, api_key=None)
    with pytest.raises(RuntimeError, match="TRANSCRIPTION_API_KEY"):
        security.assert_auth_config(host="0.0.0.0", require_auth=True, api_key="")
    with pytest.raises(RuntimeError, match="TRANSCRIPTION_API_KEY"):
        security.assert_auth_config(host="127.0.0.1", require_auth=True, api_key=None)
    # Loopback without auth stays allowed: that is the on-device default.
    security.assert_auth_config(host="127.0.0.1", require_auth=False, api_key=None)
    security.assert_auth_config(host="0.0.0.0", require_auth=True, api_key=TEST_KEY)


def test_dienst_startet_nicht_auf_nicht_loopback_ohne_schluessel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The guard has to be wired into the app's startup, not just available."""
    monkeypatch.setattr(server, "HOST", "0.0.0.0")
    monkeypatch.setattr(server, "API_KEY", None)
    monkeypatch.setattr(server, "REQUIRE_AUTH", False)

    async def enter_lifespan() -> None:
        async with server.lifespan(server.app):
            pass

    with pytest.raises(RuntimeError, match="TRANSCRIPTION_API_KEY"):
        asyncio.run(enter_lifespan())


# --------------------------------------------------------------------------
# The exposed surface
# --------------------------------------------------------------------------


def test_es_gibt_keine_endpunkte_ausser_den_drei_zugesagten() -> None:
    """FastAPI adds /docs, /redoc, /openapi.json and /docs/oauth2-redirect by
    default, and none of them carries the auth dependency. The requirement is a
    token on every endpoint except /health, so they must not exist at all.

    Asserted over ALL routes with no filtering: the previous round's route dump
    filtered those paths out before counting and then reported three.
    """
    paths = {route.path for route in server.app.routes}
    assert paths == {"/health", "/transcribe", "/jobs/{job_id}"}


def test_jeder_endpunkt_ausser_health_hat_die_auth_abhaengigkeit() -> None:
    for route in server.app.routes:
        dependencies = getattr(getattr(route, "dependant", None), "dependencies", []) or []
        names = {
            getattr(dependency.call, "__name__", "") for dependency in dependencies
        }
        if route.path == "/health":
            assert "require_api_key" not in names
        else:
            assert "require_api_key" in names, f"{route.path} has no auth dependency"


# --------------------------------------------------------------------------
# The same rules over a real socket
# --------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _call(
    url: str, method: str = "GET", body: dict | None = None, token: str | None = None
) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if data:
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = token
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, (json.loads(raw) if raw else None)


StartServer = Callable[..., tuple[str, Path]]


@pytest.fixture
def start_server(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[StartServer]:
    """Start the real app in a thread, one per test.

    Only the model LOADING is stubbed; `pipeline.transcribe` stays real, so an
    accepted job still goes through the actual worker path. Job table and work
    queue are replaced per test, so no two servers ever share them.
    """
    import uvicorn

    running: list[tuple[object, threading.Thread]] = []

    def fake_load_models(**_: object) -> pipeline.ModelBundle:
        bundle = pipeline.ModelBundle(
            model=None, diarize_model=None, device="cpu", batch_size=4
        )
        pipeline._models = bundle
        return bundle

    def _start(
        *,
        api_key: str | None = None,
        require_auth: bool = False,
        bind_host: str = "127.0.0.1",
    ) -> tuple[str, Path]:
        spool_root = tmp_path / "spool"
        spool_root.mkdir(exist_ok=True)

        monkeypatch.setattr(pipeline, "load_models", fake_load_models)
        monkeypatch.setattr(server, "API_KEY", api_key)
        monkeypatch.setattr(server, "REQUIRE_AUTH", require_auth)
        monkeypatch.setattr(server, "SPOOL_DIR", spool_root)
        monkeypatch.setattr(server, "HOST", bind_host)
        monkeypatch.setattr(server, "_jobs", server.JobStore())
        monkeypatch.setattr(server, "_work_queue", queue.Queue())

        port = _free_port()
        config = uvicorn.Config(
            server.app, host=bind_host, port=port, log_level="warning"
        )
        uvicorn_server = uvicorn.Server(config)
        thread = threading.Thread(target=uvicorn_server.run, daemon=True)
        thread.start()
        running.append((uvicorn_server, thread))

        base = f"http://127.0.0.1:{port}"
        for _ in range(200):
            try:
                _call(f"{base}/health")
                break
            except Exception:
                threading.Event().wait(0.05)
        else:
            raise RuntimeError("server did not come up")

        # Assert the premise instead of trusting it: the previous round had two
        # overlapping module-scoped fixtures, so a test could run under the
        # other one's settings and still pass.
        assert server.API_KEY == api_key
        assert server.REQUIRE_AUTH is require_auth
        assert server.SPOOL_DIR == spool_root
        return base, spool_root

    yield _start

    for uvicorn_server, thread in reversed(running):
        uvicorn_server.should_exit = True
        thread.join(timeout=10)
    pipeline._models = None


def _audio(spool_root: Path, name: str = "ok.wav") -> Path:
    audio = spool_root / name
    audio.write_bytes(b"RIFF-not-really-audio")
    return audio


def test_health_bleibt_ohne_token_erreichbar(start_server: StartServer) -> None:
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    status, payload = _call(f"{base}/health")
    assert status == 200
    assert isinstance(payload, dict) and payload["model_loaded"] is True


def test_transcribe_ohne_token_wird_abgewiesen(start_server: StartServer) -> None:
    base, spool_root = start_server(api_key=TEST_KEY, require_auth=True)
    status, _ = _call(f"{base}/transcribe", "POST", {"audio_path": str(_audio(spool_root))})
    assert status == 401


def test_transcribe_mit_falschem_token_wird_abgewiesen(start_server: StartServer) -> None:
    base, spool_root = start_server(api_key=TEST_KEY, require_auth=True)
    status, _ = _call(
        f"{base}/transcribe",
        "POST",
        {"audio_path": str(_audio(spool_root))},
        token="Bearer wrong",
    )
    assert status == 401


def test_jobs_ohne_token_wird_abgewiesen(start_server: StartServer) -> None:
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    status, _ = _call(f"{base}/jobs/whatever")
    assert status == 401


def test_transcribe_mit_token_nimmt_datei_aus_dem_spool_an(start_server: StartServer) -> None:
    """Positive control: auth and confinement must still let real work through."""
    base, spool_root = start_server(api_key=TEST_KEY, require_auth=True)
    status, payload = _call(
        f"{base}/transcribe",
        "POST",
        {"audio_path": str(_audio(spool_root, "accepted.wav"))},
        token=f"Bearer {TEST_KEY}",
    )
    assert status == 200
    assert isinstance(payload, dict) and payload["job_id"]


def test_transcribe_mit_token_lehnt_pfad_ausserhalb_ab(start_server: StartServer) -> None:
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    status, payload = _call(
        f"{base}/transcribe",
        "POST",
        {"audio_path": "/etc/hosts"},
        token=f"Bearer {TEST_KEY}",
    )
    assert status == 400
    # The message must not say which check failed, nor echo the path back.
    detail = payload["detail"] if isinstance(payload, dict) else ""
    assert "/etc/hosts" not in detail
    assert "symlink" not in detail.lower() and "spool" not in detail.lower()


def test_nullbyte_ergibt_400_nicht_500(start_server: StartServer) -> None:
    """M1 over HTTP: the generic 400, not a traceback."""
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    status, payload = _call(
        f"{base}/transcribe",
        "POST",
        {"audio_path": "a\0b.wav"},
        token=f"Bearer {TEST_KEY}",
    )
    assert status == 400
    detail = payload["detail"] if isinstance(payload, dict) else ""
    assert "Traceback" not in detail and "ValueError" not in detail


def test_docs_endpunkte_existieren_nicht(start_server: StartServer) -> None:
    """The schema and the doc UIs must be gone, not merely undocumented."""
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    for path in ("/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"):
        status, _ = _call(f"{base}{path}")
        assert status == 404, f"{path} is still served"


def test_fremder_host_header_wird_abgewiesen(start_server: StartServer) -> None:
    """The DNS-rebinding guard: the browser sends the attacker's name here."""
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    request = urllib.request.Request(
        f"{base}/health", headers={"Host": "evil.example.com"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    assert status == 400


def test_erlaubte_host_header_kommen_durch(start_server: StartServer) -> None:
    """Positive control: the allowlist must not reject the real clients."""
    base, _ = start_server(api_key=TEST_KEY, require_auth=True)
    for host in ("127.0.0.1", "localhost"):
        request = urllib.request.Request(f"{base}/health", headers={"Host": host})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 200


def test_loopback_ohne_auth_laesst_arbeiten(start_server: StartServer) -> None:
    """The on-device default must keep working without a token.

    Task 5's client relies on this, and forcing auth on unconditionally would
    break the local app while looking like a security improvement.
    """
    base, spool_root = start_server(api_key=None, require_auth=False)
    status, payload = _call(
        f"{base}/transcribe", "POST", {"audio_path": str(_audio(spool_root, "local.wav"))}
    )
    assert status == 200
    assert isinstance(payload, dict) and payload["job_id"]


def test_loopback_ohne_auth_schuetzt_trotzdem_den_spool(start_server: StartServer) -> None:
    """Path confinement is not tied to authentication being on."""
    base, _ = start_server(api_key=None, require_auth=False)
    status, _ = _call(f"{base}/transcribe", "POST", {"audio_path": "/etc/hosts"})
    assert status == 400


# --------------------------------------------------------------------------
# A remote peer, which a loopback socket cannot produce
# --------------------------------------------------------------------------


def _asgi_call(
    path: str,
    method: str = "GET",
    body: dict | None = None,
    token: str | None = None,
    client: tuple[str, int] | None = LOCAL_CLIENT,
) -> tuple[int, object]:
    """Call the ASGI app directly, choosing the peer address.

    The whole middleware and dependency stack runs; only the socket is absent,
    because a connection from 192.168.x.x cannot be made to arrive over
    loopback.
    """
    payload = json.dumps(body).encode() if body is not None else b""
    headers = [(b"host", b"127.0.0.1")]
    if body is not None:
        headers.append((b"content-type", b"application/json"))
        headers.append((b"content-length", str(len(payload)).encode()))
    if token is not None:
        headers.append((b"authorization", token.encode()))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": client,
        "server": ("127.0.0.1", 8765),
    }

    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    asyncio.run(server.app(scope, receive, send))

    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, (json.loads(raw) if raw else None)


def test_entfernter_aufrufer_wird_ohne_schluessel_abgewiesen(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The I2 bypass, end to end.

    Configuration says loopback and no auth — as it does when an external
    runner was given `--host 0.0.0.0` — but the request arrives from the
    network. It must not be served.
    """
    monkeypatch.setattr(server, "HOST", "127.0.0.1")
    monkeypatch.setattr(server, "REQUIRE_AUTH", False)
    monkeypatch.setattr(server, "API_KEY", None)
    monkeypatch.setattr(server, "SPOOL_DIR", tmp_path)

    status, _ = _asgi_call(
        "/transcribe", "POST", {"audio_path": "x.wav"}, client=REMOTE_CLIENT
    )
    assert status in (401, 503), f"remote caller was served with {status}"

    status, _ = _asgi_call("/jobs/whatever", client=REMOTE_CLIENT)
    assert status in (401, 503)


def test_entfernter_aufrufer_mit_gueltigem_schluessel_wird_bedient(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Positive control: a properly configured remote deployment still works."""
    monkeypatch.setattr(server, "HOST", "0.0.0.0")
    monkeypatch.setattr(server, "REQUIRE_AUTH", True)
    monkeypatch.setattr(server, "API_KEY", TEST_KEY)
    monkeypatch.setattr(server, "SPOOL_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "_models", None)

    # No models loaded, so 503 from the handler — but it got PAST auth, which
    # is what this asserts. A 401 here would mean the key was not accepted.
    status, _ = _asgi_call(
        "/transcribe",
        "POST",
        {"audio_path": "x.wav"},
        token=f"Bearer {TEST_KEY}",
        client=REMOTE_CLIENT,
    )
    assert status == 503

    status, _ = _asgi_call(
        "/jobs/unknown-job", token=f"Bearer {TEST_KEY}", client=REMOTE_CLIENT
    )
    assert status == 404


def test_lokaler_aufrufer_bleibt_ohne_schluessel_bedient(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The on-device case must not be caught by the remote-peer rule."""
    monkeypatch.setattr(server, "HOST", "127.0.0.1")
    monkeypatch.setattr(server, "REQUIRE_AUTH", False)
    monkeypatch.setattr(server, "API_KEY", None)
    monkeypatch.setattr(server, "SPOOL_DIR", tmp_path)
    monkeypatch.setattr(pipeline, "_models", None)

    status, _ = _asgi_call("/jobs/unknown-job", client=LOCAL_CLIENT)
    assert status == 404
