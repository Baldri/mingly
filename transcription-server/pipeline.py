"""The WhisperX transcription pipeline, taken over from TranscriboZH.

Audio in, segments with speakers and millisecond timestamps out. Nothing in
here knows about HTTP, jobs or tenants.

IMPORTANT, do not undo: whisperx, torch, pandas and pyannote are imported
INSIDE the function bodies that need them, never at module level. `get_prompt`
and `clean_segments` carry the two findings this service exists for, and both
have to stay testable in an environment that has neither the models (several
gigabytes) nor a Hugging Face account for the gated diarization weights.
Pulling those imports up to module level would make `tests/test_pipeline.py`
unrunnable.

----------------------------------------------------------------------------
Taken over from https://github.com/machinelearningZH/audio-transcription
(`src/transcription.py` and the `get_prompt` patch from `worker.py`).

MIT License

Copyright (c) 2025 Canton of Zurich / Department of Justice and Home Affairs /
Statistical Office / Team Data

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
----------------------------------------------------------------------------
"""

import dataclasses
import logging
import time
import types
from typing import Any, Callable

from pydantic import BaseModel

from const import data_leaks

logger = logging.getLogger(__name__)

# A raw segment as whisperx hands it over: "start"/"end" in seconds, "text",
# and — after speaker assignment — usually but not always a "speaker".
RawSegment = dict[str, Any]

ProgressCallback = Callable[[float], None]

# Used when diarization found no speaker overlapping a segment. whisperx then
# leaves the key out entirely; upstream reads it unguarded and raises KeyError.
UNKNOWN_SPEAKER = "SPEAKER_UNKNOWN"

# Progress after each pipeline stage, as a fraction of the whole job
# (Ruling 6: 0..1, not 0..100). Transcription and alignment dominate the
# runtime, so the steps are deliberately uneven.
_PROGRESS_AUDIO_LOADED = 0.05
_PROGRESS_TRANSCRIBED = 0.45
_PROGRESS_ALIGNED = 0.70
_PROGRESS_DIARIZED = 0.95
_PROGRESS_DONE = 1.0


class Segment(BaseModel):
    """One stretch of speech by one speaker, as the HTTP API returns it."""

    start_ms: int
    end_ms: int
    speaker: str
    text: str


@dataclasses.dataclass
class ModelBundle:
    """The models, loaded once at service start and reused for every job."""

    model: Any
    diarize_model: Any
    # The configured accelerator ("cpu", "cuda" or "mps"). Alignment and
    # diarization run here, as they do upstream. The whisper model itself may
    # sit elsewhere — see the comment in load_models.
    device: str
    batch_size: int


_models: ModelBundle | None = None


def get_prompt(
    self: Any,
    tokenizer: Any,
    previous_tokens: list[int],
    without_timestamps: bool,
    prefix: str | None,
) -> list[int]:
    """Build the decoder prompt WITHOUT the previous segment unless hotwords exist.

    This is the whole point of the service. faster-whisper always feeds the
    previous segment back in as context, which sends whisper into repetition
    loops on long audio: measured on this material, up to 58 % of the audio
    lost and a word error rate around 46 %, against 5.96 % with the context
    suppressed (`docs/superpowers/specs/2026-10-25-whisper-messung.md`,
    section 4.1). It is NOT optional.

    Taken over unchanged from TranscriboZH, which reached the same finding
    independently. It is monkey-patched onto the faster-whisper model in
    `load_models`, the way upstream does it in `worker.py`.

    The signature must match the `get_prompt` of the faster-whisper version
    that whisperx 3.2.0 pins. Later faster-whisper releases pass an additional
    `hotwords` argument; against those this patch would raise TypeError rather
    than fail quietly, but the pin in `requirements.txt` is what keeps it
    matching, so do not loosen that pin without re-checking this signature.
    """
    prompt = []

    if previous_tokens or prefix:
        prompt.append(tokenizer.sot_prev)
        if prefix:
            hotwords_tokens = tokenizer.encode(" " + prefix.strip())
            if len(hotwords_tokens) >= self.max_length // 2:
                hotwords_tokens = hotwords_tokens[: self.max_length // 2 - 1]
            prompt.extend(hotwords_tokens)
        if prefix and previous_tokens:
            prompt.extend(previous_tokens[-(self.max_length // 2 - 1):])

    prompt.extend(tokenizer.sot_sequence)

    if without_timestamps:
        prompt.append(tokenizer.no_timestamps)

    return prompt


def clean_segments(segments: list[RawSegment], language: str) -> list[RawSegment]:
    """Strip known whisper hallucinations and drop segments left empty.

    Taken over from the text-cleanup stage of TranscriboZH's `transcribe`.
    Unlike upstream, the given segments are not mutated.
    """
    leaks = data_leaks.get(language, [])
    cleaned: list[RawSegment] = []

    for segment in segments:
        text = segment["text"]
        for leak in leaks:
            if leak in text:
                text = text.replace(leak, "")
        text = text.strip()

        if not text:
            continue

        kept = dict(segment)
        kept["text"] = text
        cleaned.append(kept)

    return cleaned


def to_segments(raw_segments: list[RawSegment]) -> list[Segment]:
    """Convert whisperx segments (seconds) into API segments (milliseconds)."""
    return [
        Segment(
            start_ms=int(round(float(raw["start"]) * 1000)),
            end_ms=int(round(float(raw["end"]) * 1000)),
            speaker=raw.get("speaker") or UNKNOWN_SPEAKER,
            text=raw["text"],
        )
        for raw in raw_segments
    ]


def load_models(
    device: str,
    model_size: str,
    diarization_model: str,
    hf_auth_token: str | None,
    batch_size: int,
    download_root: str | None = None,
) -> ModelBundle:
    """Load the whisper and diarization models once and keep them.

    Called exactly once, at service start. Loading per request would re-read
    gigabytes of weights for every job.
    """
    global _models

    import torch
    import whisperx
    from pyannote.audio import Pipeline

    # ctranslate2, which faster-whisper runs on, has no Metal backend, so on
    # Apple Silicon the whisper model runs on the CPU even though pyannote can
    # use "mps". Taken over from upstream's worker.
    whisper_device = "cpu" if device == "mps" else device
    compute_type = "float16" if whisper_device == "cuda" else "float32"

    logger.info(
        "Loading whisper model %s on %s (compute type %s)",
        model_size,
        whisper_device,
        compute_type,
    )
    model = whisperx.load_model(
        model_size,
        whisper_device,
        compute_type=compute_type,
        download_root=download_root,
    )

    # The context suppression from get_prompt, patched in the way upstream does.
    model.model.get_prompt = types.MethodType(get_prompt, model.model)

    logger.info("Loading diarization model %s on %s", diarization_model, device)
    diarize_model = Pipeline.from_pretrained(
        diarization_model,
        use_auth_token=hf_auth_token,
    ).to(torch.device(device))

    _models = ModelBundle(
        model=model,
        diarize_model=diarize_model,
        device=device,
        batch_size=batch_size,
    )
    return _models


def models_loaded() -> bool:
    """Whether `load_models` has completed; reported by the health endpoint."""
    return _models is not None


def transcribe(
    audio_path: str,
    num_speakers: int | None = None,
    language: str = "de",
    on_progress: ProgressCallback | None = None,
) -> list[Segment]:
    """Transcribe one audio file into segments with speakers and timestamps.

    Four stages, taken over from TranscriboZH: transcription, forced alignment
    (this is where the word-accurate timestamps come from), diarization with
    speaker assignment, and the hallucination cleanup. Upstream's optional
    fifth stage — per-segment language detection for multilingual meetings —
    is deliberately left out; the API has no field for a per-segment language.
    """
    import whisperx

    if _models is None:
        raise RuntimeError("Models are not loaded; call load_models() first.")
    bundle = _models

    _empty_cache(bundle.device)
    started = time.monotonic()

    audio = whisperx.load_audio(audio_path)
    _report(on_progress, _PROGRESS_AUDIO_LOADED)

    logger.info("Transcribing %s", audio_path)
    transcription = bundle.model.transcribe(
        audio,
        batch_size=bundle.batch_size,
        language=language,
    )
    detected_language = transcription["language"]
    _report(on_progress, _PROGRESS_TRANSCRIBED)

    logger.info("Aligning (language %s)", detected_language)
    align_model, metadata = whisperx.load_align_model(
        language_code=detected_language,
        device=bundle.device,
    )
    aligned = whisperx.align(
        transcription["segments"],
        align_model,
        metadata,
        audio,
        bundle.device,
        return_char_alignments=False,
    )
    _report(on_progress, _PROGRESS_ALIGNED)

    logger.info("Diarizing (num_speakers=%s)", num_speakers)
    diarized = _assign_speakers(audio, aligned, num_speakers, bundle)
    _report(on_progress, _PROGRESS_DIARIZED)

    cleaned = clean_segments(diarized["segments"], detected_language)
    segments = to_segments(cleaned)

    _empty_cache(bundle.device)
    logger.info(
        "Transcribed %s into %d segments in %.1f s",
        audio_path,
        len(segments),
        time.monotonic() - started,
    )
    _report(on_progress, _PROGRESS_DONE)
    return segments


def _assign_speakers(
    audio: Any,
    aligned: dict[str, Any],
    num_speakers: int | None,
    bundle: ModelBundle,
) -> dict[str, Any]:
    """Run diarization and attach a speaker to every word, then every segment."""
    import pandas as pd
    import torch
    import whisperx
    from whisperx.audio import SAMPLE_RATE

    audio_data = {
        "waveform": torch.from_numpy(audio[None, :]),
        "sample_rate": SAMPLE_RATE,
    }
    diarization = bundle.diarize_model(audio_data, num_speakers=num_speakers)

    diarize_df = pd.DataFrame(
        diarization.itertracks(yield_label=True),
        columns=["segment", "label", "speaker"],
    )
    diarize_df["start"] = diarize_df["segment"].apply(lambda track: track.start)
    diarize_df["end"] = diarize_df["segment"].apply(lambda track: track.end)

    return whisperx.assign_word_speakers(diarize_df, aligned)


def _empty_cache(device: str) -> None:
    """Return GPU memory between jobs; one worker, so this is safe to do."""
    import torch

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if device == "mps" and torch.backends.mps.is_available():
        torch.mps.empty_cache()


def _report(on_progress: ProgressCallback | None, progress: float) -> None:
    if on_progress is not None:
        on_progress(progress)
