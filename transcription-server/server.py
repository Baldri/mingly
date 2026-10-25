#!/usr/bin/env python3
"""HTTP service around the transcription pipeline.

Audio path in, segments with speakers and timestamps out, following the same
pattern as `rag-server`: Mingly's Electron main process talks to this over
HTTP. Policy, tenants, audit and persistence stay on the TypeScript side.

Two constraints from the spec shape this file:

- The models are loaded ONCE, at service start. An hour of audio is not a
  request-response affair, and re-reading gigabytes of weights per request
  would dominate the runtime.
- There is EXACTLY ONE worker per process, and jobs are strictly serialized.
  More than one worker exhausts the VRAM — upstream's README says so outright
  ("Make sure not to run the worker script multiple times"), so the capacity
  limit of a deployment is one worker per GPU, not throughput (spec 10.3).

Jobs live in memory and are deliberately NOT persisted here: the job table,
resumption after a crash and the audit trail belong to Mingly's SQLite layer
(spec 6.2). A restart of this service therefore loses its queue, and the
TypeScript job runner is what re-submits.
"""

import logging
import os
import queue
import sys
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, AsyncIterator, Literal

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

import pipeline
import security
from pipeline import Segment

logging.basicConfig(
    level=os.getenv("TRANSCRIPTION_LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("transcription-server")

# Audio is the most sensitive payload Mingly handles, so the service binds to
# localhost by default. Binding anywhere else requires an API key, and the
# service refuses to start without one — see security.assert_auth_config.
HOST: str = os.getenv("TRANSCRIPTION_HOST", "127.0.0.1")
PORT: int = int(os.getenv("TRANSCRIPTION_PORT", "8765"))

# Authentication, following Mingly's own server (MINGLY_REQUIRE_AUTH /
# MINGLY_API_KEY in src/server/index.ts). Off by default, which is safe only
# because the default bind is loopback; any other bind forces it on.
REQUIRE_AUTH: bool = os.getenv("TRANSCRIPTION_REQUIRE_AUTH", "").lower() == "true"
API_KEY: str | None = os.getenv("TRANSCRIPTION_API_KEY") or None

# Submitted audio must resolve inside this directory. Without that, POST
# /transcribe plus GET /jobs/{id} would read back any audio file on the host.
SPOOL_DIR: Path = Path(
    os.getenv("TRANSCRIPTION_SPOOL_DIR") or Path(__file__).resolve().parent / "spool"
)

DEVICE: str = os.getenv("TRANSCRIPTION_DEVICE", "cpu")
MODEL_SIZE: str = os.getenv("TRANSCRIPTION_MODEL", "large-v3")
# Upstream's model id, kept as-is. Which diarization model to ship is an open
# product decision tied to the Hugging Face gating question (spec 10.3), so it
# is configurable rather than decided here.
DIARIZATION_MODEL: str = os.getenv(
    "TRANSCRIPTION_DIARIZATION_MODEL", "pyannote/speaker-diarization"
)
HF_AUTH_TOKEN: str | None = os.getenv("HF_AUTH_TOKEN")
BATCH_SIZE: int = int(os.getenv("TRANSCRIPTION_BATCH_SIZE", "4"))
MODEL_DOWNLOAD_ROOT: str | None = os.getenv("TRANSCRIPTION_MODEL_ROOT")

JobState = Literal["queued", "running", "done", "failed"]


class TranscribeRequest(BaseModel):
    audio_path: str = Field(..., description="Absolute path to the audio file")
    num_speakers: int | None = Field(
        default=None, ge=1, description="Known speaker count; detected when omitted"
    )
    language: str = Field(default="de", description="ISO 639-1 language code")


class TranscribeResponse(BaseModel):
    job_id: str


class JobStatusResponse(BaseModel):
    state: JobState
    # Ruling 6: a fraction from 0 to 1, not a percentage.
    progress: float
    segments: list[Segment]
    # Not in the original endpoint sketch, added deliberately: without it a
    # failed job cannot tell the caller why, and the TypeScript job runner is
    # required to fail with a clear message.
    error: str | None = None


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    device: str


class Job(BaseModel):
    job_id: str
    state: JobState = "queued"
    progress: float = 0.0
    segments: list[Segment] = Field(default_factory=list)
    error: str | None = None


class JobStore:
    """The in-memory job table.

    Written by the worker thread and read by the request handlers, so every
    access takes the lock.

    DEBT: jobs are never evicted, so the table grows for the lifetime of the
    process. That holds while this service is started per Mingly session and
    the SQLite job table on the TypeScript side is the record of truth
    (spec 6.2) -> add eviction of finished jobs once this runs as a shared
    instance (spec stage 2, "Betrieb") or the process RSS passes ~1 GB in
    operation, whichever comes first.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self) -> Job:
        job = Job(job_id=str(uuid.uuid4()))
        with self._lock:
            self._jobs[job.job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(job_id)
            # A copy, so a caller never reads a half-written update.
            return job.model_copy(deep=True) if job is not None else None

    def set_running(self, job_id: str) -> None:
        with self._lock:
            self._jobs[job_id].state = "running"

    def set_progress(self, job_id: str, progress: float) -> None:
        with self._lock:
            self._jobs[job_id].progress = progress

    def set_done(self, job_id: str, segments: list[Segment]) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.state = "done"
            job.progress = 1.0
            job.segments = segments

    def set_failed(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.state = "failed"
            job.error = error


class QueuedJob(BaseModel):
    """What the worker needs, with an already validated path.

    The path here has been through security.resolve_spool_path; the worker
    never sees the string the caller submitted.
    """

    model_config = {"arbitrary_types_allowed": True}

    job_id: str
    audio_path: Path
    num_speakers: int | None
    language: str


_jobs = JobStore()
# `None` is the stop sentinel, so shutdown can reap the worker instead of
# leaving a thread parked on get() for the life of the process.
_work_queue: "queue.Queue[QueuedJob | None]" = queue.Queue()


def _worker_loop() -> None:
    """Take one job at a time and run the pipeline on it.

    Exactly one thread runs this. Any failure is recorded on the job and
    logged with its traceback; the loop itself must not die, or every queued
    job would hang forever.
    """
    while True:
        queued = _work_queue.get()
        if queued is None:
            _work_queue.task_done()
            return
        job_id = queued.job_id
        try:
            _jobs.set_running(job_id)
            segments = pipeline.transcribe(
                str(queued.audio_path),
                queued.num_speakers,
                queued.language,
                on_progress=lambda progress, bound_id=job_id: _jobs.set_progress(
                    bound_id, progress
                ),
            )
            _jobs.set_done(job_id, segments)
            logger.info("Job %s done, %d segments", job_id, len(segments))
        except Exception as error:
            logger.exception("Job %s failed", job_id)
            _jobs.set_failed(job_id, f"{type(error).__name__}: {error}")
        finally:
            _work_queue.task_done()


async def require_api_key(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Reject a request that does not carry the configured bearer token.

    Applied to every endpoint except /health, which has to stay reachable
    unauthenticated so the TypeScript client can tell "service down" from
    "service up but misconfigured".

    The decision uses the REAL peer address, not just the configured bind:
    an external runner given `--host 0.0.0.0` leaves HOST at 127.0.0.1, and a
    configuration-only check would serve the network unauthenticated. See
    security.auth_required_for_request.
    """
    client_host = request.client.host if request.client else None
    required = security.auth_required_for_request(client_host, HOST, REQUIRE_AUTH)

    if required and not API_KEY:
        # Reachable but keyless. check_api_key would already deny, but say so
        # distinctly: this is our misconfiguration, not a bad token.
        logger.error(
            "Refusing request from %s: authentication is required for this "
            "binding, but TRANSCRIPTION_API_KEY is not set",
            client_host,
        )
        raise HTTPException(status_code=503, detail="Service is misconfigured.")

    if security.check_api_key(authorization, configured=API_KEY, require_auth=required):
        return

    raise HTTPException(
        status_code=401,
        detail="Unauthorized.",
        headers={"WWW-Authenticate": "Bearer"},
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load the models, then start the single worker.

    If loading fails — no whisperx installed, or the gated diarization weights
    are unavailable — the service still starts, reports `model_loaded: false`
    on /health and refuses jobs with 503. That beats exiting, because the
    TypeScript side can then show the operator what is wrong instead of only
    seeing a connection error.

    A missing API key on a non-loopback bind is the one condition that is NOT
    survivable: it would serve the transcription capability to the network
    unauthenticated, so it raises and startup aborts.
    """
    security.assert_auth_config(host=HOST, require_auth=REQUIRE_AUTH, api_key=API_KEY)
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(
        "Auth: %s | spool: %s",
        "required" if security.auth_required(HOST, REQUIRE_AUTH) else "disabled (loopback)",
        SPOOL_DIR,
    )

    try:
        pipeline.load_models(
            device=DEVICE,
            model_size=MODEL_SIZE,
            diarization_model=DIARIZATION_MODEL,
            hf_auth_token=HF_AUTH_TOKEN,
            batch_size=BATCH_SIZE,
            download_root=MODEL_DOWNLOAD_ROOT,
        )
    except Exception:
        logger.exception("Model loading failed; starting without a model and refusing jobs")
        worker: threading.Thread | None = None
    else:
        # Exactly one. Never make this a pool.
        worker = threading.Thread(
            target=_worker_loop, name="transcription-worker", daemon=True
        )
        worker.start()
        logger.info("Transcription service ready on http://%s:%d", HOST, PORT)

    yield

    if worker is not None:
        _work_queue.put(None)
        worker.join(timeout=10)


app = FastAPI(
    title="Mingly Transcription Server",
    description="WhisperX transcription with speaker diarization",
    version="1.0.0",
    lifespan=lifespan,
    # No /docs, /redoc, /openapi.json or /docs/oauth2-redirect. FastAPI adds
    # those four routes by default and they carry NO dependencies, so with them
    # the service would have four unauthenticated endpoints and the rule "a
    # token on everything except /health" would simply be untrue. There is no
    # per-route way to put the auth dependency on them, so they are switched
    # off; the three real routes are documented in README.md instead.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# A Host allowlist is what defeats DNS rebinding: a browser can be steered to
# 127.0.0.1, but it still sends the attacker's hostname in the Host header.
# Deliberately no CORS middleware — unlike rag-server, which allows "*".
app.add_middleware(TrustedHostMiddleware, allowed_hosts=security.allowed_hosts(HOST))


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    loaded = pipeline.models_loaded()
    return HealthResponse(
        status="healthy" if loaded else "degraded",
        model_loaded=loaded,
        device=DEVICE,
    )


@app.post(
    "/transcribe",
    response_model=TranscribeResponse,
    dependencies=[Depends(require_api_key)],
)
async def submit_transcription(request: TranscribeRequest) -> TranscribeResponse:
    if not pipeline.models_loaded():
        raise HTTPException(
            status_code=503,
            detail="Models are not loaded; the service cannot accept jobs.",
        )

    try:
        audio_path = security.resolve_spool_path(request.audio_path, SPOOL_DIR)
    except security.AudioPathRejected as rejected:
        # The reason goes to the log, never to the caller: which check tripped,
        # and whether some path exists, is not theirs to probe for.
        logger.warning("Rejected audio path: %s", rejected)
        raise HTTPException(status_code=400, detail="Audio file is not usable.") from None

    job = _jobs.create()
    # The RESOLVED path is what the worker gets, so it transcribes exactly what
    # was validated.
    _work_queue.put(
        QueuedJob(
            job_id=job.job_id,
            audio_path=audio_path,
            num_speakers=request.num_speakers,
            language=request.language,
        )
    )
    logger.info("Job %s queued for %s", job.job_id, audio_path)
    return TranscribeResponse(job_id=job.job_id)


@app.get(
    "/jobs/{job_id}",
    response_model=JobStatusResponse,
    dependencies=[Depends(require_api_key)],
)
async def get_job(job_id: str) -> JobStatusResponse:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    return JobStatusResponse(
        state=job.state,
        progress=job.progress,
        segments=job.segments,
        error=job.error,
    )


if __name__ == "__main__":
    # One process, one worker thread, one set of models. Raising the worker
    # count would load the models several times over and exhaust the VRAM.
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
