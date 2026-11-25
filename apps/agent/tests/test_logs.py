import logging
from types import SimpleNamespace

import pytest
from livekit.agents.cli.log import ColoredFormatter, JsonFormatter

from aule_agent import worker
from aule_agent.logs import WithoutPersonalFields, keep_personal_fields_out


class Kept(logging.Handler):
    """A handler as LiveKit sets them up, writing what it formats."""

    def __init__(self, formatter: logging.Formatter) -> None:
        super().__init__()
        self.setFormatter(formatter)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


@pytest.fixture
def root():
    """The root logger's handlers as they were, filters included, after the test."""
    logger = logging.getLogger()
    handlers = list(logger.handlers)
    filters = {handler: list(handler.filters) for handler in handlers}
    yield logger
    for handler in list(logger.handlers):
        if handler not in handlers:
            logger.removeHandler(handler)
    for handler, kept in filters.items():
        handler.filters = kept


def logged(formatter: logging.Formatter, **extra: object) -> str:
    handler = Kept(formatter)
    handler.addFilter(WithoutPersonalFields())
    logger = logging.getLogger("livekit.agents.synthetic")
    logger.addHandler(handler)
    try:
        logger.warning("final transcript not received after timeout", extra=extra)
    finally:
        logger.removeHandler(handler)
    (line,) = handler.lines
    return line


@pytest.mark.parametrize(
    "formatter",
    [JsonFormatter(), ColoredFormatter("%(levelname)s %(name)s %(message)s %(extra)s")],
    ids=["production", "development"],
)
def test_livekits_formatters_write_no_field_that_carries_what_a_child_said(formatter):
    line = logged(
        formatter,
        **{
            "lk.pii.interim_transcript": "zanahoria azul",
            "lk.pii.user_input": "siete ocho",
            "lk.pii.arguments": '{"said": "nueve"}',
            "transcript_timeout": 0.8,
        },
    )

    assert "final transcript not received after timeout" in line
    assert "transcript_timeout" in line
    for words in ("zanahoria azul", "siete ocho", "nueve", "lk.pii"):
        assert words not in line


def test_only_fields_with_a_pii_part_are_dropped():
    line = logged(JsonFormatter(), **{"pii_count": 1, "lk.piiz": 2, "api": 3, "lk.pii": 4})

    assert '"pii_count": 1' in line and '"lk.piiz": 2' in line and '"api": 3' in line
    assert '"lk.pii": 4' not in line


def test_the_filter_goes_once_on_every_handler_of_the_root_logger(root):
    first, second = Kept(JsonFormatter()), Kept(JsonFormatter())
    root.addHandler(first)
    root.addHandler(second)

    keep_personal_fields_out()
    keep_personal_fields_out()

    for handler in (first, second):
        assert [type(f) for f in handler.filters].count(WithoutPersonalFields) == 1


def test_a_job_process_filters_its_records_before_they_leave_it(root, monkeypatch):
    # LiveKit's job process sends its records to the worker through a handler
    # on its root logger, added before the process is set up (prewarm).
    to_the_worker = Kept(JsonFormatter())
    root.addHandler(to_the_worker)
    monkeypatch.setattr(worker.silero.VAD, "load", lambda **options: "vad")
    proc = SimpleNamespace(userdata={})

    worker.prewarm(proc)
    logging.getLogger("livekit.agents").warning(
        "skipping reply", extra={"lk.pii.user_input": "zanahoria azul"}
    )

    assert proc.userdata["vad"] == "vad"
    assert to_the_worker.lines and "zanahoria" not in to_the_worker.lines[-1]


async def test_the_worker_process_filters_its_records_once_it_starts(root, monkeypatch):
    written = Kept(JsonFormatter())
    root.addHandler(written)

    async def check_gates() -> None:
        return None

    monkeypatch.setattr(worker, "check_gates", check_gates)

    worker.announce()
    logging.getLogger("livekit.agents").warning(
        "skipping reply", extra={"lk.pii.user_input": "zanahoria azul"}
    )

    assert "zanahoria" not in written.lines[-1]
