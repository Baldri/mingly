"""Tests for authentication and audio-path confinement.

The HTTP-level tests drive a real uvicorn server over `urllib`. That is the
long way round, but `fastapi.testclient.TestClient` needs `httpx`, which is
deliberately not installed (Ruling 8), and these assertions are worth having
at the HTTP level: an auth check that only works when called directly is not
an auth check.
"""

import asyncio
import json
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterator

import pytest

import pipeline
import security
import server

TEST_KEY = "test-key-do-not-use-anywhere"


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


# --------------------------------------------------------------------------
# Key comparison and the startup guard
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
# The same rules, over real HTTP
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
        return error.code, json.loads(error.read() or b"null")


def _serve(
    spool_root: Path, api_key: str | None, require_auth: bool
) -> Iterator[tuple[str, Path]]:
    """Run the real app in a thread with the given auth settings.

    Only the model LOADING is stubbed; `pipeline.transcribe` stays real, so an
    accepted job still goes through the actual worker path.
    """
    import uvicorn

    def fake_load_models(**_: object) -> pipeline.ModelBundle:
        bundle = pipeline.ModelBundle(
            model=None, diarize_model=None, device="cpu", batch_size=4
        )
        pipeline._models = bundle
        return bundle

    originals = (pipeline.load_models, server.API_KEY, server.REQUIRE_AUTH, server.SPOOL_DIR)
    pipeline.load_models = fake_load_models
    server.API_KEY = api_key
    server.REQUIRE_AUTH = require_auth
    server.SPOOL_DIR = spool_root

    port = _free_port()
    config = uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning")
    uvicorn_server = uvicorn.Server(config)
    thread = threading.Thread(target=uvicorn_server.run, daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try:
            _call(f"{base}/health")
            break
        except Exception:
            threading.Event().wait(0.05)
    else:
        raise RuntimeError("server did not come up")

    try:
        yield base, spool_root
    finally:
        uvicorn_server.should_exit = True
        thread.join(timeout=10)
        pipeline._models = None
        (pipeline.load_models, server.API_KEY, server.REQUIRE_AUTH, server.SPOOL_DIR) = originals


@pytest.fixture(scope="module")
def live_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[str, Path]]:
    """A real server with auth switched on."""
    yield from _serve(tmp_path_factory.mktemp("spool"), api_key=TEST_KEY, require_auth=True)


@pytest.fixture(scope="module")
def live_server_no_auth(
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[tuple[str, Path]]:
    """The on-device default: loopback bind, no key, auth off."""
    yield from _serve(tmp_path_factory.mktemp("spool-open"), api_key=None, require_auth=False)


def test_health_bleibt_ohne_token_erreichbar(live_server: tuple[str, Path]) -> None:
    base, _ = live_server
    status, payload = _call(f"{base}/health")
    assert status == 200
    assert isinstance(payload, dict) and payload["model_loaded"] is True


def test_transcribe_ohne_token_wird_abgewiesen(live_server: tuple[str, Path]) -> None:
    base, spool_root = live_server
    audio = spool_root / "ok.wav"
    audio.write_bytes(b"RIFF-not-really-audio")
    status, _ = _call(f"{base}/transcribe", "POST", {"audio_path": str(audio)})
    assert status == 401


def test_transcribe_mit_falschem_token_wird_abgewiesen(live_server: tuple[str, Path]) -> None:
    base, spool_root = live_server
    audio = spool_root / "ok.wav"
    audio.write_bytes(b"RIFF-not-really-audio")
    status, _ = _call(
        f"{base}/transcribe", "POST", {"audio_path": str(audio)}, token="Bearer wrong"
    )
    assert status == 401


def test_jobs_ohne_token_wird_abgewiesen(live_server: tuple[str, Path]) -> None:
    base, _ = live_server
    status, _ = _call(f"{base}/jobs/whatever")
    assert status == 401


def test_transcribe_mit_token_nimmt_datei_aus_dem_spool_an(
    live_server: tuple[str, Path],
) -> None:
    """Positive control: the auth and confinement checks must still let real work through."""
    base, spool_root = live_server
    audio = spool_root / "accepted.wav"
    audio.write_bytes(b"RIFF-not-really-audio")
    status, payload = _call(
        f"{base}/transcribe",
        "POST",
        {"audio_path": str(audio)},
        token=f"Bearer {TEST_KEY}",
    )
    assert status == 200
    assert isinstance(payload, dict) and payload["job_id"]


def test_fremder_host_header_wird_abgewiesen(live_server: tuple[str, Path]) -> None:
    """The DNS-rebinding guard: the browser sends the attacker's name here."""
    base, _ = live_server
    request = urllib.request.Request(
        f"{base}/health", headers={"Host": "evil.example.com"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    assert status == 400


def test_erlaubte_host_header_kommen_durch(live_server: tuple[str, Path]) -> None:
    """Positive control: the allowlist must not reject the real clients."""
    base, _ = live_server
    for host in ("127.0.0.1", "localhost"):
        request = urllib.request.Request(f"{base}/health", headers={"Host": host})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 200


def test_loopback_ohne_auth_laesst_arbeiten(live_server_no_auth: tuple[str, Path]) -> None:
    """The on-device default must keep working without a token.

    Task 5's client relies on this, and forcing auth on unconditionally would
    break the local app while looking like a security improvement.
    """
    base, spool_root = live_server_no_auth
    audio = spool_root / "local.wav"
    audio.write_bytes(b"RIFF-not-really-audio")
    status, payload = _call(f"{base}/transcribe", "POST", {"audio_path": str(audio)})
    assert status == 200
    assert isinstance(payload, dict) and payload["job_id"]


def test_loopback_ohne_auth_schuetzt_trotzdem_den_spool(
    live_server_no_auth: tuple[str, Path],
) -> None:
    """Path confinement is not tied to authentication being on."""
    base, _ = live_server_no_auth
    status, _ = _call(f"{base}/transcribe", "POST", {"audio_path": "/etc/hosts"})
    assert status == 400


def test_transcribe_mit_token_lehnt_pfad_ausserhalb_ab(live_server: tuple[str, Path]) -> None:
    base, _ = live_server
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
