"""Run both watches with fake commands: no network, mail, Docker or live state."""

import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WATCHES = ("aule-watch.sh", "aule-watch-outside.sh")
FAKE_COMMAND = r"""
import base64
from email import policy
from email.parser import BytesParser
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["WATCH_TEST_ROOT"])
settings = json.loads((root / "settings.json").read_text())
command = Path(sys.argv[0]).name
args = sys.argv[1:]
if command == "curl":
    if "--upload-file" in args:
        message = BytesParser(policy=policy.default).parsebytes(
            Path(args[args.index("--upload-file") + 1]).read_bytes())
        delivery = {"subject": str(message["Subject"]), "body": message.get_content()}
    elif "--data-binary" in args:
        message = json.loads(args[args.index("--data-binary") + 1])
        delivery = {"subject": message["subject"], "body": message["text"]}
    else:
        endpoint = args[-1]
        failure = settings["failure"]
        unavailable = (failure == "session" and ("8091/healthz" in endpoint or
                       endpoint.endswith("/session/healthz"))) or (
                       failure == "shop" and "shop." in endpoint)
        sys.exit(22 if unavailable else 0)
    with (root / "deliveries.jsonl").open("a") as out:
        out.write(json.dumps(delivery) + "\n")
    sys.exit(0 if settings["mail_ok"] else 22)
elif command == "date":
    print(settings["now"] if args == ["+%s"] else "2026-11-23 00:00 UTC")
elif command == "docker":
    if "psql" in args:
        if settings.get("reports") == "unavailable":
            sys.exit(1)
        print(settings.get("reports", "0"))
    else:
        print("healthy" if "Health.Status" in " ".join(args) else "true")
elif command == "df":
    print("Use%\n15%")
elif command == "find":
    print("/synthetic-backup.sql.gz.gpg")
elif command == "hostname":
    print("watch-test")
elif command == "base64":
    print(base64.b64encode(sys.stdin.buffer.read()).decode())
elif command != "sleep":
    raise RuntimeError("Unexpected command: " + command)
"""


class WatchHarness:
    def __init__(self, root: Path, watch: str) -> None:
        self.root = root
        self.state_dir = root / "state"
        self.state_dir.mkdir()
        prefix = "watch-outside" if "outside" in watch else "watch"
        self.state = self.state_dir / (prefix + ".failing")
        self.last_mail = self.state_dir / (prefix + ".last-mail")
        self.settings = {"now": 1_800_000_000, "failure": "", "mail_ok": True}
        fake_bin = root / "bin"
        fake_bin.mkdir()
        fake = fake_bin / "fake-command"
        fake.write_text("#!" + sys.executable + "\n" + FAKE_COMMAND)
        fake.chmod(0o755)
        for command in (
            "curl",
            "date",
            "docker",
            "df",
            "find",
            "hostname",
            "base64",
            "sleep",
        ):
            (fake_bin / command).symlink_to(fake.name)
        self.environ = {
            **os.environ,
            "WATCH_TEST_ROOT": str(root),
            "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
        }
        # Relocate only constants; run the real delivery and state-transition code.
        text = (Path(__file__).parent / watch).read_text()
        if "outside" in watch:
            replacements = {
                'STATE_DIR="$HOME/.local/state/aule"': "STATE_DIR="
                + shlex.quote(str(self.state_dir)),
                'KEY_FILE="$HOME/.config/aule/resend-key"': "KEY_FILE="
                + shlex.quote(str(root / "mail-key")),
            }
        else:
            replacements = {
                "STATE_DIR=/home/aule-admin/.local/state/aule": "STATE_DIR="
                + shlex.quote(str(self.state_dir)),
                "ENV=/etc/aule/aule.env": "ENV=" + shlex.quote(str(root / "mail.env")),
            }
        for original, replacement in replacements.items():
            if text.count(original) != 1:
                raise ValueError(
                    "Watch paths changed; update the test sandbox before running it"
                )
            text = text.replace(original, replacement)
        (root / "mail.env").write_text(
            "AULE_SMTP_URL=smtp://example.invalid\nAULE_MAIL_FROM=watch@example.invalid\n"
        )
        (root / "mail-key").write_text("synthetic-key\n")
        self.script = root / watch
        self.script.write_text(text)

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        (self.root / "settings.json").write_text(json.dumps(self.settings))
        return subprocess.run(
            ["bash", str(self.script), *args],
            env=self.environ,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

    def snapshot(self) -> tuple[bytes | None, bytes | None]:
        return tuple(
            p.read_bytes() if p.exists() else None for p in (self.state, self.last_mail)
        )

    def deliveries(self) -> list[dict]:
        path = self.root / "deliveries.jsonl"
        return (
            [json.loads(line) for line in path.read_text().splitlines()]
            if path.exists()
            else []
        )


class WatchTests(unittest.TestCase):
    def test_report_backlog_and_database_errors_alert_and_recover(self) -> None:
        for reports in ("1", "9", "", "invalid", "unavailable"):
            with (
                self.subTest(reports=reports),
                tempfile.TemporaryDirectory() as directory,
            ):
                harness = WatchHarness(Path(directory), "aule-watch.sh")
                harness.settings["reports"] = reports
                self.assertEqual(harness.run().returncode, 0)
                self.assertIn("informes", harness.state.read_text())
                self.assertEqual(len(harness.deliveries()), 1)
                harness.settings["reports"] = "0"
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(harness.state.read_text().strip(), "")
                self.assertEqual(len(harness.deliveries()), 2)

    def test_failed_recovery_is_retried_at_next_check(self) -> None:
        for watch in WATCHES:
            with self.subTest(watch=watch), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), watch)
                harness.settings["failure"] = "session"
                self.assertEqual(harness.run().returncode, 0)
                notified = harness.snapshot()
                harness.settings.update(failure="", mail_ok=False, now=1_800_000_300)
                self.assertNotEqual(harness.run().returncode, 0)
                self.assertEqual(harness.snapshot(), notified)
                harness.settings.update(mail_ok=True, now=1_800_000_600)
                self.assertEqual(harness.run().returncode, 0)
                deliveries = harness.deliveries()
                self.assertEqual(len(deliveries), 3)
                self.assertEqual(deliveries[1]["subject"], deliveries[2]["subject"])
                for check in notified[0].decode().splitlines():
                    self.assertIn(check, deliveries[2]["body"])
                self.assertEqual(harness.state.read_text().strip(), "")
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(len(harness.deliveries()), 3)

    def test_changed_failure_retries_without_waiting_for_reminder(self) -> None:
        for watch in WATCHES:
            with self.subTest(watch=watch), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), watch)
                harness.settings["failure"] = "session"
                self.assertEqual(harness.run().returncode, 0)
                notified = harness.snapshot()
                harness.settings.update(
                    failure="shop", mail_ok=False, now=1_800_000_300
                )
                self.assertNotEqual(harness.run().returncode, 0)
                self.assertEqual(harness.snapshot(), notified)
                harness.settings.update(mail_ok=True, now=1_800_000_600)
                self.assertEqual(harness.run().returncode, 0)
                deliveries = harness.deliveries()
                self.assertEqual(len(deliveries), 3)
                self.assertEqual(deliveries[1]["subject"], deliveries[2]["subject"])
                self.assertIn("tienda", harness.state.read_text())
                self.assertEqual(
                    int(harness.last_mail.read_text()), harness.settings["now"]
                )

    def test_healthy_checks_and_reminders_do_not_duplicate_mail(self) -> None:
        for watch in WATCHES:
            with self.subTest(watch=watch), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), watch)
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(harness.deliveries(), [])
                harness.settings["failure"] = "session"
                self.assertEqual(harness.run().returncode, 0)
                harness.settings["now"] += 6 * 3600 - 1
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(len(harness.deliveries()), 1)
                harness.settings["now"] += 1
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(len(harness.deliveries()), 2)
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(len(harness.deliveries()), 2)

    def test_test_mail_does_not_acknowledge_an_incident(self) -> None:
        for watch in WATCHES:
            with self.subTest(watch=watch), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), watch)
                harness.settings["failure"] = "session"
                self.assertEqual(harness.run().returncode, 0)
                notified = harness.snapshot()
                self.assertEqual(harness.run("--test").returncode, 0)
                self.assertEqual(harness.snapshot(), notified)
                self.assertEqual(len(harness.deliveries()), 2)


if __name__ == "__main__":
    unittest.main()
