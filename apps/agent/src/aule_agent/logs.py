"""Keeps what a child says out of the log lines LiveKit writes.

LiveKit puts the user's words in fields of its log records named
``lk.pii.*``: the interim transcript when a final one is late, the words of a
turn it skips, a tool's arguments. Its formatters write every field of a
record, so those words would reach the log. The filter takes the fields off
each record before any handler formats it.
"""

import logging


class WithoutPersonalFields(logging.Filter):
    """Drops every field of a record with ``pii`` as a part of its dotted name."""

    def filter(self, record: logging.LogRecord) -> bool:
        for name in [name for name in vars(record) if "pii" in name.split(".")]:
            delattr(record, name)
        return True


_FILTER = WithoutPersonalFields()


def keep_personal_fields_out() -> None:
    """Puts the filter on every handler of the root logger, once each.

    Called once LiveKit has set up a process's logging: in the worker process
    when it starts, and in each job process before and as a session starts.
    """
    for handler in logging.getLogger().handlers:
        if _FILTER not in handler.filters:
            handler.addFilter(_FILTER)
