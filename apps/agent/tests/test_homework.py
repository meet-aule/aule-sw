"""The reader of a photo of the homework, with a stand-in for the model's
client: no network and no paid call."""

import asyncio
import base64
import io
import json
import logging
from types import SimpleNamespace

import anthropic
import pytest
from anthropic import transform_schema
from livekit import rtc
from PIL import Image

from aule_agent.homework import (
    MAX_TOKENS,
    MODEL,
    QUESTION,
    SCHEMA,
    TIMEOUT_SECONDS,
    UNAVAILABLE,
    HomeworkReader,
    Reading,
)

READ = {"shows": "fractions_homework", "level": 3, "confidence": 0.82}
PAID = SimpleNamespace(input_tokens=1400, output_tokens=20)


def frame(width=1280, height=720):
    return rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, bytes(width * height * 4))


def answer(data, *, stop_reason="end_turn"):
    text = data if isinstance(data, str) else json.dumps(data)
    return SimpleNamespace(
        stop_reason=stop_reason, content=[SimpleNamespace(type="text", text=text)], usage=PAID
    )


class FakeClient:
    def __init__(self, reply=None, delay=0.0):
        self.reply = answer(READ) if reply is None else reply
        self.delay, self.calls, self.closed = delay, [], False
        self.messages = SimpleNamespace(create=self.create)

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        await asyncio.sleep(self.delay)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    async def close(self):
        self.closed = True


def photo_in(call):
    (message,) = call["messages"]
    (block,) = message["content"]
    return block["source"]["data"]


async def test_fractions_homework_is_read_with_its_level_and_how_sure_the_model_is():
    assert await HomeworkReader(client=FakeClient()).read(frame()) == Reading("read", 3, 0.82)


@pytest.mark.parametrize(
    ("shows", "outcome"),
    [
        ("other_homework", "other_subject"),
        ("no_homework", "no_homework"),
        ("unreadable", "unreadable"),
    ],
)
async def test_a_photo_with_no_fraction_exercise_to_read_carries_no_level(shows, outcome):
    client = FakeClient(answer({"shows": shows, "level": 0, "confidence": 0.9}))

    assert await HomeworkReader(client=client).read(frame()) == Reading(outcome)


async def test_the_photo_goes_alone_with_the_question_and_thinking_off():
    client = FakeClient()

    await HomeworkReader(client=client).read(frame())

    (call,) = client.calls
    # No temperature, no tools: nothing but what the plan asks for.
    assert set(call) == {"model", "max_tokens", "thinking", "output_config", "system", "messages"}
    assert (call["model"], call["max_tokens"], call["system"]) == (MODEL, MAX_TOKENS, QUESTION)
    assert MODEL == "claude-sonnet-5-5" and MAX_TOKENS == 256
    assert call["thinking"] == {"type": "between_tools"}
    assert call["output_config"] == {
        "effort": "low",
        "format": {"type": "json_schema", "schema": SCHEMA},
    }
    (message,) = call["messages"]
    (block,) = message["content"]
    assert message["role"] == "user"
    assert block == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": photo_in(call)},
    }
    # Sent once: nothing of the request is written to the prompt cache.
    assert "cache_control" not in json.dumps(call)


def test_the_schema_is_one_the_api_takes_as_written():
    # The SDK rewrites a schema with keywords the API does not take (a minimum,
    # a maximum); this one it leaves as it is.
    assert transform_schema(SCHEMA) == SCHEMA
    assert SCHEMA["additionalProperties"] is False
    assert set(SCHEMA["required"]) == set(SCHEMA["properties"])


@pytest.mark.parametrize(
    ("size", "sent"),
    [
        ((1280, 720), (1024, 576)),
        ((720, 1280), (576, 1024)),
        ((4032, 3024), (1024, 768)),
        # A smaller photo is not enlarged.
        ((640, 480), (640, 480)),
    ],
)
async def test_the_photo_is_a_jpeg_no_larger_than_1024_px(size, sent):
    client = FakeClient()

    await HomeworkReader(client=client).read(frame(*size))

    image = Image.open(io.BytesIO(base64.standard_b64decode(photo_in(client.calls[0]))))
    assert (image.format, image.size) == ("JPEG", sent)


@pytest.mark.parametrize(
    "reply",
    [
        answer(READ, stop_reason="refusal"),
        answer(READ, stop_reason="max_tokens"),
        answer('{"shows": "fractions_homework", "level": 3, "conf'),
        answer("Level 3."),
        answer([READ]),
        answer({**READ, "notes": "the child wrote 5/7"}),
        answer({"shows": "fractions_homework", "level": 3}),
        answer({**READ, "shows": "maths_homework"}),
        # A read needs a level from 1 to 5, as an integer.
        answer({**READ, "level": 0}),
        answer({**READ, "level": 6}),
        answer({**READ, "level": 2.0}),
        answer({**READ, "level": True}),
        # A confidence from 0 to 1, as a number.
        answer({**READ, "confidence": 1.5}),
        answer({**READ, "confidence": -0.1}),
        answer({**READ, "confidence": "0.8"}),
        answer({**READ, "confidence": True}),
        answer('{"shows": "fractions_homework", "level": 3, "confidence": NaN}'),
        # A level for a photo with no fraction exercise contradicts it.
        answer({"shows": "other_homework", "level": 2, "confidence": 0.9}),
    ],
)
async def test_anything_not_fully_understood_is_unavailable(reply):
    reading = await HomeworkReader(client=FakeClient(reply)).read(frame())

    assert reading == UNAVAILABLE and reading.level is None and reading.confidence is None


async def test_no_answer_in_time_a_failed_call_or_a_frame_that_cannot_be_sent_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("aule_agent.homework.TIMEOUT_SECONDS", 0.01)

    assert await HomeworkReader(client=FakeClient(delay=1)).read(frame()) == UNAVAILABLE
    assert await HomeworkReader(client=FakeClient(RuntimeError("down"))).read(frame()) == (
        UNAVAILABLE
    )
    client = FakeClient()
    assert await HomeworkReader(client=client).read(object()) == UNAVAILABLE
    assert client.calls == []


async def test_cancelling_is_not_swallowed_and_the_client_is_closed_with_it():
    client = FakeClient(delay=1)
    reader = HomeworkReader(client=client)
    task = asyncio.create_task(reader.read(frame()))
    await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    await reader.close()
    assert client.closed


async def test_every_answer_is_counted_a_refusal_too_and_no_answer_is_not():
    counted = []

    await HomeworkReader(client=FakeClient(), counted=counted.append).read(frame())
    await HomeworkReader(
        client=FakeClient(answer(READ, stop_reason="refusal")), counted=counted.append
    ).read(frame())
    await HomeworkReader(client=FakeClient(RuntimeError("down")), counted=counted.append).read(
        frame()
    )

    assert counted == [PAID, PAID]


def extras(record):
    standard = set(logging.LogRecord("x", logging.INFO, "x", 1, "x", (), None).__dict__)
    return set(record.__dict__) - standard - {"message", "asctime"}


async def test_the_log_says_the_outcome_and_how_long_it_took_and_nothing_of_the_photo(caplog):
    caplog.set_level(logging.INFO, logger="aule.agent.homework")
    client = FakeClient(answer({**READ, "level": 4, "confidence": 0.8125}))

    assert (await HomeworkReader(client=client).read(frame())).level == 4
    await HomeworkReader(client=FakeClient(RuntimeError("down"))).read(frame())

    read, failed, unavailable = [r for r in caplog.records if r.name == "aule.agent.homework"]
    assert read.getMessage() == "homework read" and extras(read) == {"outcome", "duration_ms"}
    assert (read.outcome, type(read.duration_ms)) == ("read", int)
    assert failed.getMessage() == "homework not read" and extras(failed) == {"error"}
    assert failed.error == "RuntimeError"
    assert unavailable.outcome == "unavailable"
    logged = " ".join(str(record.__dict__) for record in caplog.records)
    assert "0.8125" not in logged and photo_in(client.calls[0])[:64] not in logged


async def test_the_client_has_its_own_time_limit_and_no_retries(monkeypatch):
    built = []

    def client(**options):
        built.append(options)
        return FakeClient()

    monkeypatch.setattr(anthropic, "AsyncAnthropic", client)

    assert await HomeworkReader().read(frame()) == Reading("read", 3, 0.82)
    assert built == [{"timeout": 8.0, "max_retries": 0}] and TIMEOUT_SECONDS == 8.0
