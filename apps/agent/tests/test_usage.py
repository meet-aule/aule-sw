import contextvars
from types import SimpleNamespace

from aule_agent.providers import EARLY, Early
from aule_agent.usage import Usage


def test_a_session_adds_up_its_model_calls():
    usage = Usage()
    usage.add(SimpleNamespace(prompt_tokens=3466, prompt_cached_tokens=3310, completion_tokens=66))
    usage.add(SimpleNamespace(prompt_tokens=3500, prompt_cached_tokens=0, completion_tokens=40))

    assert usage.summary() == {
        "llm_calls": 2,
        "input_tokens": 6966,
        "cached_input_tokens": 3310,
        "cache_write_tokens": 0,
        "output_tokens": 106,
        "stt_seconds": 0.0,
        "tts_chars": 0,
    }


def test_metrics_without_the_expected_counts_add_nothing_but_the_call():
    usage = Usage()
    usage.add(SimpleNamespace(prompt_tokens=None, completion_tokens=-1))

    assert usage.summary() == {
        "llm_calls": 1,
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "cache_write_tokens": 0,
        "output_tokens": 0,
        "stt_seconds": 0.0,
        "tts_chars": 0,
    }


def test_the_audio_heard_and_the_characters_spoken_add_up():
    usage = Usage()
    usage.add(
        SimpleNamespace(
            prompt_tokens=100, prompt_cached_tokens=0, cache_creation_tokens=90, completion_tokens=5
        )
    )
    usage.heard(SimpleNamespace(audio_duration=12.34))
    usage.heard(SimpleNamespace(audio_duration=0.0))
    usage.heard(SimpleNamespace(audio_duration=None))
    usage.spoke(SimpleNamespace(characters_count=120))
    usage.spoke(SimpleNamespace(characters_count=-3))

    summary = usage.summary()
    assert (summary["cache_write_tokens"], summary["stt_seconds"], summary["tts_chars"]) == (
        90,
        12.3,
        120,
    )


def test_an_early_request_is_paid_like_any_call_and_told_apart_when_its_reply_went_unused():
    usage = Usage()
    used, dropped = Early(), Early()

    def call(early, tokens):
        context = contextvars.copy_context()
        context.run(EARLY.set, early)
        context.run(usage.add, SimpleNamespace(prompt_tokens=tokens, completion_tokens=30))

    call(None, 9000)
    call(used, 9100)
    call(dropped, 9200)
    # Whether a reply was used is known after its call was counted.
    used.used = True

    summary = usage.summary()
    assert (summary["llm_calls"], summary["input_tokens"], summary["output_tokens"]) == (
        3,
        27300,
        90,
    )
    assert (summary["early_calls_dropped"], summary["early_input_tokens_dropped"]) == (1, 9200)


def test_without_early_requests_the_session_reports_what_it_always_did():
    usage = Usage()
    usage.add(SimpleNamespace(prompt_tokens=10, completion_tokens=1))

    assert not [name for name in usage.summary() if name.startswith("early")]
