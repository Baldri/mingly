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
from typing import AsyncIterator, Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import pipeline
from pipeline import Segment

logging.basicConfig(
    level=os.getenv("TRANSCRIPTION_LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("transcription-server")

# Audio is the most sensitive payload Mingly handles, so the service binds to
# localhost unless the operator says otherwise. A container in the customer's
# private cloud sets TRANSCRIPTION_HOST=0.0.0.0 knowingly.
HOST: str = os.getenv("TRANSCRIPTION_HOST", "127.0.0.1")
PORT: int = int(os.getenv("TRANSCRIPTION_PORT", "8765"))

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


_jobs = JobStore()
_work_queue: "queue.Queue[tuple[str, TranscribeRequest]]" = queue.Queue()


def _worker_loop() -> None:
    """Take one job at a time and run the pipeline on it.

    Exactly one thread runs this. Any failure is recorded on the job and
    logged with its traceback; the loop itself must not die, or every queued
    job would hang forever.
    """
    while True:
        job_id, request = _work_queue.get()
        try:
            _jobs.set_running(job_id)
            segments = pipeline.transcribe(
                request.audio_path,
                request.num_speakers,
                request.language,
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


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load the models, then start the single worker.

    If loading fails — no whisperx installed, or the gated diarization weights
    are unavailable — the service still starts, reports `model_loaded: false`
    on /health and refuses jobs with 503. That beats exiting, because the
    TypeScript side can then show the operator what is wrong instead of only
    seeing a connection error.
    """
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
    else:
        # Exactly one. Never make this a pool.
        threading.Thread(target=_worker_loop, name="transcription-worker", daemon=True).start()
        logger.info("Transcription service ready on http://%s:%d", HOST, PORT)

    yield


app = FastAPI(
    title="Mingly Transcription Server",
    description="WhisperX transcription with speaker diarization",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    loaded = pipeline.models_loaded()
    return HealthResponse(
        status="healthy" if loaded else "degraded",
        model_loaded=loaded,
        device=DEVICE,
    )


@app.post("/transcribe", response_model=TranscribeResponse)
async def submit_transcription(request: TranscribeRequest) -> TranscribeResponse:
    if not pipeline.models_loaded():
        raise HTTPException(
            status_code=503,
            detail="Models are not loaded; the service cannot accept jobs.",
        )

    path = Path(request.audio_path)
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"Audio file not found: {request.audio_path}")
    if path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail=f"Audio file is empty: {request.audio_path}")

    job = _jobs.create()
    _work_queue.put((job.job_id, request))
    logger.info("Job %s queued for %s", job.job_id, request.audio_path)
    return TranscribeResponse(job_id=job.job_id)


@app.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job(job_id: str) -> JobStatusResponse:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
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
