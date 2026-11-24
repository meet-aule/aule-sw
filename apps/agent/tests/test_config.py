import pytest

from aule_agent.config import ConfigError, Settings, build_commit

COMPLETE = {
    "LIVEKIT_URL": "ws://127.0.0.1:7880",
    "LIVEKIT_API_KEY": "key",
    "LIVEKIT_API_SECRET": "secret",
    "ANTHROPIC_API_KEY": "sk-test",
    "AULE_STT": "assemblyai",
    "ASSEMBLYAI_API_KEY": "aai",
    "AULE_TTS": "cartesia",
    "CARTESIA_API_KEY": "car",
}


def test_reads_a_complete_environment_with_defaults():
    settings = Settings.from_env(COMPLETE)

    assert settings.agent_name == "aule-tutor"
    assert (settings.stt, settings.tts) == ("assemblyai", "cartesia")
    assert settings.language == "es"
    assert settings.session_max_minutes == 15
    assert settings.break_minutes == 5
    assert settings.tts_voice is None


def test_reports_every_problem_at_once():
    with pytest.raises(ConfigError) as error:
        Settings.from_env(
            {"AULE_STT": "deepgram", "AULE_SESSION_MAX_MINUTES": "0", "AULE_BREAK_MINUTES": "60"}
        )

    message = str(error.value)
    for expected in (
        "AULE_TTS must be one of",
        "LIVEKIT_URL is not set",
        "ANTHROPIC_API_KEY is not set",
        "DEEPGRAM_API_KEY is not set",
        "AULE_SESSION_MAX_MINUTES",
        "AULE_BREAK_MINUTES",
    ):
        assert expected in message


def test_requires_the_key_of_the_chosen_provider_only():
    env = {**COMPLETE, "AULE_TTS": "openai"}

    with pytest.raises(ConfigError, match="^OPENAI_API_KEY is not set$"):
        Settings.from_env(env)


def test_a_blank_key_counts_as_missing():
    with pytest.raises(ConfigError, match="CARTESIA_API_KEY is not set"):
        Settings.from_env({**COMPLETE, "CARTESIA_API_KEY": "  "})


def test_rejects_an_unsupported_language():
    with pytest.raises(ConfigError, match="AULE_LANGUAGE"):
        Settings.from_env({**COMPLETE, "AULE_LANGUAGE": "fr"})


def test_each_gate_is_configured_by_its_key_and_no_key_is_shown():
    assert not Settings.from_env(COMPLETE).gates_complete
    assert not Settings.from_env({**COMPLETE, "OPENAI_API_KEY": "sk-secret"}).gates_complete
    assert not Settings.from_env({**COMPLETE, "TYPESAFE_API_KEY": "ts-secret"}).gates_complete

    settings = Settings.from_env(
        {**COMPLETE, "OPENAI_API_KEY": " sk-secret ", "TYPESAFE_API_KEY": "ts-secret"}
    )

    assert settings.gates_complete
    assert (settings.openai_api_key, settings.typesafe_api_key) == ("sk-secret", "ts-secret")
    assert "secret" not in repr(settings)


def test_assemblyai_speaks_with_the_key_it_also_hears_with():
    # The STT key doubles as the TTS key, so choosing assemblyai for speech
    # needs nothing beyond what hearing already required.
    settings = Settings.from_env({**COMPLETE, "AULE_TTS": "assemblyai"})

    assert settings.tts == "assemblyai"


def test_push_to_talk_is_off_unless_turned_on():
    assert Settings.from_env(COMPLETE).push_to_talk is False
    assert Settings.from_env({**COMPLETE, "AULE_PUSH_TO_TALK": "1"}).push_to_talk is True
    assert Settings.from_env({**COMPLETE, "AULE_PUSH_TO_TALK": "true"}).push_to_talk is True
    assert Settings.from_env({**COMPLETE, "AULE_PUSH_TO_TALK": "no"}).push_to_talk is False


def test_the_moderation_key_is_also_the_speech_key_when_openai_speaks():
    settings = Settings.from_env({**COMPLETE, "AULE_TTS": "openai", "OPENAI_API_KEY": "sk"})

    assert settings.tts == "openai"
    assert settings.openai_api_key == "sk"


def test_a_blank_gate_key_means_no_gate_and_a_broken_one_is_a_problem():
    blank = Settings.from_env({**COMPLETE, "OPENAI_API_KEY": " ", "TYPESAFE_API_KEY": ""})
    assert (blank.openai_api_key, blank.typesafe_api_key) == (None, None)

    with pytest.raises(ConfigError) as error:
        Settings.from_env(
            {**COMPLETE, "OPENAI_API_KEY": "sk test", "TYPESAFE_API_KEY": "ts\x00test"}
        )
    assert "OPENAI_API_KEY must not contain" in str(error.value)
    assert "TYPESAFE_API_KEY must not contain" in str(error.value)
    assert "sk test" not in str(error.value)


def test_the_tutor_model_answers_with_text_not_only_thinking(monkeypatch):
    # On a model that thinks by default, the thinking counts against the reply
    # ceiling and can leave no text: every call must limit it to between tools.
    from livekit.plugins import anthropic

    from aule_agent import providers

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    seen = {}
    monkeypatch.setattr(anthropic.LLM, "chat", lambda self, **kwargs: seen.update(kwargs))

    providers.build_llm(Settings.from_env(COMPLETE)).chat(chat_ctx=None)
    assert seen["extra_kwargs"]["thinking"] == {"type": "between_tools"}

    seen.clear()
    other = Settings.from_env({**COMPLETE, "AULE_LLM_MODEL": "claude-opus-5-5"})
    built = providers.build_llm(other)
    built.chat(chat_ctx=None)
    assert "extra_kwargs" not in seen
    assert built._opts.max_tokens == providers.MAX_TOKENS_WITH_THINKING


def test_the_commit_is_the_one_the_image_was_given_or_unknown():
    assert build_commit({}) == "unknown"
    assert build_commit({"AULE_COMMIT": " 0123456789ab "}) == "0123456789ab"
    assert build_commit({"AULE_COMMIT": "a" * 40}) == "a" * 40
    for odd in ("abc12", "0123456789AB", '"><script>', "0123456789ab-dirty", "a" * 41):
        assert build_commit({"AULE_COMMIT": odd}) == "unknown", odd
