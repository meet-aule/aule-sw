import asyncio
from types import SimpleNamespace

import pytest

from aule_agent.opinion import (
    HEARD_QUESTION,
    JEV_MODEL,
    MODEL,
    ORDINARY_MAX,
    QUESTION,
    SecondOpinion,
    jev_concern,
)


class FakeClient:
    def __init__(self, answer="SAFE", delay=0.0):
        self.answer, self.delay, self.calls, self.closed = answer, delay, [], False
        self.messages = SimpleNamespace(create=self.create)

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        await asyncio.sleep(self.delay)
        if isinstance(self.answer, Exception):
            raise self.answer
        return SimpleNamespace(
            content=[
                SimpleNamespace(type="thinking", thinking="SAFE"),
                SimpleNamespace(type="text", text=self.answer),
            ]
        )

    async def close(self):
        self.closed = True


async def test_only_the_word_safe_is_a_yes():
    assert await SecondOpinion(client=FakeClient(" safe\n")).safe("cuenta las canicas")
    for answer in ("UNSAFE", "SAFE, I think", "", "yes"):
        assert not await SecondOpinion(client=FakeClient(answer)).safe("x")


async def test_the_reply_is_sent_alone_to_the_small_model():
    client = FakeClient()

    await SecondOpinion(client=client).safe("cuenta las canicas")

    assert client.calls[0]["model"] == MODEL
    assert client.calls[0]["system"] == QUESTION
    assert client.calls[0]["messages"] == [{"role": "user", "content": "cuenta las canicas"}]


async def test_no_opinion_is_not_a_yes(monkeypatch):
    monkeypatch.setattr("aule_agent.opinion.TIMEOUT_SECONDS", 0.01)

    assert not await SecondOpinion(client=FakeClient(delay=1)).safe("x")
    assert not await SecondOpinion(client=FakeClient(RuntimeError("down"))).safe("x")


async def test_cancelling_is_not_swallowed_and_the_client_is_closed_with_it():
    client = FakeClient(delay=1)
    opinion = SecondOpinion(client=client)
    task = asyncio.create_task(opinion.safe("x"))
    await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    await opinion.close()
    assert client.closed


async def test_a_childs_words_are_ordinary_concern_or_unsettled():
    async def read(answer):
        return await SecondOpinion(client=FakeClient(answer)).ordinary("¿Hacemos otro?", "x")

    assert await read(" ordinary\n") is True
    assert await read("CONCERN") is False
    for answer in ("ORDINARY, I think", "", "SAFE", "SCHOOLWORK"):
        assert await read(answer) is None


async def test_the_reader_gets_the_childs_words_with_the_tutors_line_before_them():
    client = FakeClient("ORDINARY")

    await SecondOpinion(client=client).ordinary(" ¿Hacemos otro? ", " ya no quiero seguir ")
    await SecondOpinion(client=client).ordinary("", "ya no quiero seguir")

    assert all(call["system"] == HEARD_QUESTION for call in client.calls)
    assert [call["messages"][0]["content"] for call in client.calls] == [
        "Tutor: ¿Hacemos otro?\nChild: ya no quiero seguir",
        "Tutor: (nothing yet)\nChild: ya no quiero seguir",
    ]


async def test_a_reader_that_is_late_or_down_settles_nothing(monkeypatch):
    monkeypatch.setattr("aule_agent.opinion.TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr("aule_agent.opinion.HEARD_TIMEOUT_SECONDS", 0.01)

    assert await SecondOpinion(client=FakeClient("ORDINARY", delay=1)).ordinary("", "x") is None
    assert await SecondOpinion(client=FakeClient(RuntimeError("down"))).ordinary("", "x") is None


async def test_a_childs_words_wait_longer_for_their_reading_than_a_reply(monkeypatch):
    # The small model thinks before it answers: a child is not cut off by a
    # reading that came a little late, a reply of the tutor still is.
    monkeypatch.setattr("aule_agent.opinion.TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr("aule_agent.opinion.HEARD_TIMEOUT_SECONDS", 1.0)
    heard = FakeClient("ORDINARY", delay=0.05)
    assert await SecondOpinion(client=heard).ordinary("", "son tres negritos de cuatro") is True
    assert heard.calls[0]["timeout"] == 1.0
    assert not await SecondOpinion(client=FakeClient("SAFE", delay=0.05)).safe("x")


async def test_a_warm_up_lists_models_and_asks_no_model_anything():
    listed = []

    async def models(**options):
        listed.append(options)
        raise RuntimeError("down")

    client = FakeClient()
    client.models = SimpleNamespace(list=models)

    await SecondOpinion(client=client).warm()

    assert listed == [{"limit": 1}] and client.calls == []


class FakeJev:
    def __init__(self, concern):
        self.value, self.calls, self.closed = concern, [], False

    async def concern(self, tutor, child):
        self.calls.append((tutor, child))
        return self.value

    async def close(self):
        self.closed = True


async def test_a_clear_ordinary_from_jev_settles_it_without_the_small_model():
    client, jev = FakeClient("CONCERN"), FakeJev(ORDINARY_MAX)
    reader = SecondOpinion(client=client, jev=jev)

    assert await reader.ordinary("¿Seguimos?", "ya no quiero seguir, terminemos") is True
    assert jev.calls == [("¿Seguimos?", "ya no quiero seguir, terminemos")]
    assert client.calls == []
    await reader.close()
    assert jev.closed and client.closed


@pytest.mark.parametrize("concern", [ORDINARY_MAX + 0.001, 0.11, 0.9, None])
async def test_anything_but_a_clear_ordinary_from_jev_goes_to_the_small_model(concern):
    # Over the threshold, or no usable answer in time: the small model decides,
    # and its "concern" stands.
    client = FakeClient("CONCERN")
    reader = SecondOpinion(client=client, jev=FakeJev(concern))

    assert (
        await reader.ordinary("¿Cuánto te salió?", "a veces pienso que sería mejor no existir")
        is False
    )
    assert len(client.calls) == 1


async def test_without_jev_the_small_model_reads_as_before():
    client = FakeClient("ORDINARY")
    assert await SecondOpinion(client=client).ordinary("¿Seguimos?", "ya volví") is True
    assert len(client.calls) == 1


def test_only_a_well_formed_answer_from_the_pinned_model_is_read():
    good = (
        b'{"model": "%s", "answers": {"concern": {"type": "noul", "noul": 0.03}}}'
        % JEV_MODEL.encode()
    )
    assert jev_concern(good) == 0.03
    for bad in (
        good.replace(JEV_MODEL.encode(), b"jev-latest"),
        good.replace(b"0.03", b"1.5"),
        good.replace(b"0.03", b'"0.03"'),
        good.replace(b'"concern"', b'"needs_adult"'),
        good.replace(b'"noul", "noul"', b'"bool", "noul"'),
        b"not json",
    ):
        with pytest.raises((ValueError, KeyError, TypeError)):
            jev_concern(bad)
