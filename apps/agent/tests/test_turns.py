from livekit.agents import AgentSession

from aule_agent.worker import PUSH_TO_TALK_TURNS, SPEECH_LIKELIHOOD, SPEECH_MIN_SECONDS, TURNS


async def test_the_session_takes_the_turn_options_for_noisy_homes():
    options = AgentSession(turn_handling=TURNS).options.turn_handling
    # A noise with no words in it does not stop the tutor, and a short one is not speech.
    assert options["interruption"]["min_words"] >= 1
    assert options["interruption"]["min_duration"] >= 0.8
    assert options["interruption"]["mode"] == "vad"
    # A noise that stopped it all the same is undone: LiveKit's default, kept.
    assert options["interruption"]["resume_false_interruption"] is True
    # A child's pause in the middle of a sentence does not end the turn at once.
    assert options["endpointing"]["min_delay"] >= 0.7
    assert 0.5 < SPEECH_LIKELIHOOD < 0.7 and 0.05 < SPEECH_MIN_SECONDS <= 0.2


async def test_push_to_talk_keeps_the_same_options_with_manual_turns():
    options = AgentSession(turn_handling=PUSH_TO_TALK_TURNS).options.turn_handling
    assert options["turn_detection"] == "manual"
    assert options["interruption"]["min_words"] == TURNS["interruption"]["min_words"]
    assert (
        options["interruption"]
        == AgentSession(turn_handling=TURNS).options.turn_handling["interruption"]
    )


async def test_a_released_talk_button_ends_the_turn_at_once():
    # The button is the end of the turn: no pause is waited for after it.
    options = AgentSession(turn_handling=PUSH_TO_TALK_TURNS).options.turn_handling
    assert options["endpointing"]["min_delay"] == 0
    assert options["endpointing"]["max_delay"] == TURNS["endpointing"]["max_delay"]
    # Without the button, a child's pause still does not end the turn.
    assert TURNS["endpointing"]["min_delay"] >= 0.7


async def test_livekit_never_asks_the_model_before_the_gates_in_either_mode():
    # In VAD mode LiveKit's preemptive generation would run the tutor's
    # llm_node before on_user_turn_completed, so before the input gates.
    for turns in (TURNS, PUSH_TO_TALK_TURNS):
        options = AgentSession(turn_handling=turns).options
        assert options.preemptive_generation["enabled"] is False
