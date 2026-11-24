import asyncio
import logging
from pathlib import Path

from aule_agent import worker
from aule_agent._version import __version__


def test_the_version_is_the_repositorys():
    source = Path(__file__).resolve().parents[3] / "version.txt"

    assert __version__ == source.read_text(encoding="utf-8").strip()


async def test_the_worker_names_its_build_in_the_logs_once_it_runs(monkeypatch, caplog):
    monkeypatch.setenv("AULE_COMMIT", "0123456789ab")
    checks = []

    async def check_gates():
        checks.append("gates")

    monkeypatch.setattr(worker, "check_gates", check_gates)

    with caplog.at_level(logging.INFO, logger="aule.agent"):
        worker.server.emit("worker_started")
        await asyncio.gather(*worker._background)

    assert f"aule-agent {__version__} (0123456789ab)" in caplog.messages
    # Beside it, and without holding the worker up, the gates are asked once.
    assert checks == ["gates"]
