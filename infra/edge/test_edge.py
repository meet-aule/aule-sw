"""The Workers' settings, read as wrangler reads them: no line per request in
Cloudflare's logs, and no traces. LiveKit's address carries a room token, and a
sign-in's way back carries its code. And the code each one deploys takes the
analytics cookies out the same way."""

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
        self.assertEqual(names, ["wrangler.livekit.jsonc", "wrangler.ota.jsonc", "wrangler.playground.jsonc"])
        for name in names:
            with self.subTest(name):
                observability = config(name)["observability"]
                self.assertIs(observability["logs"]["invocation_logs"], False)
                # Off unless asked for; a span would carry the address too.
                self.assertIsNot(observability.get("traces", {}).get("enabled"), True)


class EdgeCookiesTests(unittest.TestCase):
    def test_every_worker_deploys_the_same_cookie_rule_and_uses_it(self) -> None:
        # apps/playground/test/edge.test.mjs runs both Workers through the cases;
        # this checks that the file each wrangler config deploys has the same
        # copy of the function, and calls it.
        definition = "\nfunction stripAnalyticsCookies(headers) {\n"
        functions = set()
        for path in sorted(HERE.glob("wrangler.*.jsonc")):
            if path.name == "wrangler.ota.jsonc":
                continue  # OTA never forwards incoming headers at all.
            with self.subTest(path.name):
                source = (HERE / config(path.name)["main"]).read_text()
                self.assertIn(definition, source)
                start = source.index(definition)
                functions.add(source[start : source.index("\n}\n", start)])
                self.assertGreaterEqual(source.count("stripAnalyticsCookies("), 2)
        self.assertEqual(len(functions), 1)


class OtaRoutingTests(unittest.TestCase):
    def test_all_assets_pass_the_route_allowlist_and_have_no_preview(self) -> None:
        ota = config("wrangler.ota.jsonc")
        self.assertIs(ota["assets"]["run_worker_first"], True)
        self.assertIs(ota["workers_dev"], False)
        self.assertIs(ota["preview_urls"], False)


if __name__ == "__main__":
    unittest.main()
