"""The Workers' settings, read as wrangler reads them: no line per request in
Cloudflare's logs, and no traces. LiveKit's address carries a room token, and a
sign-in's way back carries its code."""

import json
import unittest
from pathlib import Path

HERE = Path(__file__).parent


def without_comments(text: str) -> str:
    """JSONC without its // and /* */ comments, leaving strings as they are."""
    kept: list[str] = []
    at = 0
    in_string = False
    while at < len(text):
        char = text[at]
        if in_string and char == "\\":
            # An escaped character, a quote included, is part of the string.
            kept.append(text[at : at + 2])
            at += 2
        elif in_string:
            in_string = char != '"'
            kept.append(char)
            at += 1
        elif char == '"':
            in_string = True
            kept.append(char)
            at += 1
        elif text.startswith("//", at):
            end = text.find("\n", at)
            at = len(text) if end == -1 else end
        elif text.startswith("/*", at):
            at = text.index("*/", at) + 2
        else:
            kept.append(char)
            at += 1
    return "".join(kept)


def config(name: str) -> dict:
    return json.loads(without_comments((HERE / name).read_text()))


class EdgeLogsTests(unittest.TestCase):
    def test_comments_go_and_addresses_stay(self) -> None:
        text = '{\n  // a note\n  "url": "http://x/y", /* another */ "s": "a\\"//b"\n}'
        self.assertEqual(
            json.loads(without_comments(text)), {"url": "http://x/y", "s": 'a"//b'}
        )

    def test_no_worker_logs_a_line_per_request_or_traces_one(self) -> None:
        names = sorted(path.name for path in HERE.glob("wrangler.*.jsonc"))
        self.assertEqual(names, ["wrangler.livekit.jsonc", "wrangler.playground.jsonc"])
        for name in names:
            with self.subTest(name):
                observability = config(name)["observability"]
                self.assertIs(observability["logs"]["invocation_logs"], False)
                # Off unless asked for; a span would carry the address too.
                self.assertIsNot(observability.get("traces", {}).get("enabled"), True)


if __name__ == "__main__":
    unittest.main()
