"""Tests for the two pipeline parts that must work without any model loaded.

`get_prompt` and `clean_segments` are deliberately free of whisperx, torch and
pyannote imports (see the module docstring of `pipeline.py`), which is what
makes them testable here: no model download, no GPU, no Hugging Face token.
Everything downstream of them needs the real models and is therefore not
covered by this file.
"""

from pipeline import clean_segments, get_prompt


class FakeTokenizer:
    """Minimal stand-in for the faster-whisper tokenizer.

    The ids are whisper's real special-token ids. None of them collides with
    the `previous_tokens` the tests pass in, so a test that looks for those
    tokens in the prompt cannot be fooled by a coincidence.
    """

    sot_prev = 50361
    sot_sequence = (50258, 50259, 50360)
    no_timestamps = 50363

    def encode(self, text: str) -> list[int]:
        return [70000 + len(text)]


class FakeModel:
    """Stand-in for the faster-whisper model; `get_prompt` reads `max_length`."""

    max_length = 448


def test_get_prompt_laesst_previous_tokens_weg_ohne_prefix() -> None:
    """Der Kern des Patches: ohne Hotwords kein Kontext aus dem Vorsegment.
    Ohne das liegt die Fehlerrate bei 46 % statt 6 % (Messreport 4.1)."""
    prompt = get_prompt(FakeModel(), FakeTokenizer(), previous_tokens=[1, 2, 3],
                        without_timestamps=True, prefix=None)
    assert 1 not in prompt and 2 not in prompt and 3 not in prompt
    # Nothing else may leak in either, so pin the whole prompt.
    assert prompt == [
        FakeTokenizer.sot_prev,
        *FakeTokenizer.sot_sequence,
        FakeTokenizer.no_timestamps,
    ]


def test_get_prompt_nimmt_previous_tokens_mit_wenn_hotwords_vorliegen() -> None:
    """Positive control for the test above.

    The patch suppresses the previous segment only when there are no hotwords.
    An implementation that dropped `previous_tokens` unconditionally would pass
    the test above for the wrong reason and silently lose hotword context.
    """
    prompt = get_prompt(FakeModel(), FakeTokenizer(), previous_tokens=[1, 2, 3],
                        without_timestamps=True, prefix="Mingly")
    assert 1 in prompt and 2 in prompt and 3 in prompt


def test_data_leaks_entfernt_zdf_halluzination() -> None:
    seg = {"text": " Untertitel im Auftrag des ZDF, 2017"}
    assert clean_segments([seg], "de") == []


def test_clean_segments_behaelt_echten_text() -> None:
    """Positive control for the test above.

    A `clean_segments` that always returned an empty list would satisfy the
    test above. Real speech has to survive, with surrounding space trimmed.
    """
    kept = clean_segments([{"text": "  Guten Tag, Herr Meier.  "}], "de")
    assert kept == [{"text": "Guten Tag, Herr Meier."}]
