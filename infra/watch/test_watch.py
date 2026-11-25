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
import datetime
from email import policy
from email.parser import BytesParser
import json
import os
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

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
                       failure == "shop" and "shop." in endpoint) or (
                       failure == "public" and "playground.meetaule.com" in endpoint)
        counts_file = root / "probes.json"
        counts = json.loads(counts_file.read_text()) if counts_file.exists() else {}
        counts[endpoint] = counts.get(endpoint, 0) + 1
        counts_file.write_text(json.dumps(counts))
        if settings.get("blip") and counts[endpoint] > 1:
            unavailable = False
        if "--write-out" in args:
            print((settings.get("http_code", "503") if unavailable else "200") + " 0.125")
        if unavailable:
            print("synthetic private response must not enter mail", file=sys.stderr)
        sys.exit(settings.get("curl_code", 0) if unavailable else 0)
    with (root / "deliveries.jsonl").open("a") as out:
        out.write(json.dumps(delivery) + "\n")
    sys.exit(0 if settings["mail_ok"] else 22)
elif command == "date":
    if args == ["+%s"]:
        print(settings["now"])
    else:
        stamp = int(args[args.index("-d") + 1][1:]) if "-d" in args else settings["now"]
        zone = ZoneInfo(os.environ.get("TZ", "UTC"))
        instant = datetime.datetime.fromtimestamp(stamp, zone)
        print(instant.strftime(args[-1][1:] if args[-1].startswith("+") else "%a, %d %b %Y %H:%M:%S %z"))
elif command == "docker":
    if "psql" in args:
        if settings.get("reports") == "unavailable":
            sys.exit(1)
        print(settings.get("reports", "0"))
    else:
        print("healthy" if "Health.Status" in " ".join(args) else "true")
elif command == "df":
    print("Use%\n" + str(settings.get("disk", 15)) + "%")
elif command == "find":
    print("/synthetic-backup.sql.gz.gpg")
elif command == "hostname":
    print("watch-test")
elif command == "base64":
    print(base64.b64encode(sys.stdin.buffer.read()).decode())
elif command == "python3":
    if args and args[0].endswith("/.local/lib/aule/offsite-health.py"):
        sys.exit(0 if settings.get("backup_ok", True) else 1)
    os.execv(sys.executable, [sys.executable, *args])
elif command != "sleep":
    raise RuntimeError("Unexpected command: " + command)
"""


class WatchHarness:
    def __init__(self, root: Path, watch: str) -> None:
        self.root = root
        self.state_dir = root / "state"
        self.state_dir.mkdir()
        (self.state_dir / "restore.ok").write_text("1800000000\n")
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
            "python3",
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
        common = Path(__file__).parent / "aule-watch-common.sh"
        (root / common.name).write_text(common.read_text())

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        (self.root / "settings.json").write_text(json.dumps(self.settings))
        return subprocess.run(
            ["bash", self.script.name, *args],
            cwd=self.root,
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

    def test_restore_failure_staleness_and_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = WatchHarness(Path(directory), "aule-watch.sh")
            stamp = harness.state_dir / "restore.ok"
            for value in ("", "garbled", "1800000001", "1799308800"):
                stamp.write_text(value)
                self.assertEqual(harness.run().returncode, 0)
                self.assertIn("restauración", harness.state.read_text())
            stamp.write_text("1800000000")
            self.assertEqual(harness.run().returncode, 0)
            self.assertEqual(harness.state.read_text().strip(), "")
            self.assertEqual(len(harness.deliveries()), 2)

    def test_offsite_backup_failure_alerts_and_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = WatchHarness(Path(directory), "aule-watch-outside.sh")
            harness.settings["backup_ok"] = False
            self.assertEqual(harness.run().returncode, 0)
            self.assertIn("respaldo externo", harness.state.read_text())
            self.assertEqual(len(harness.deliveries()), 1)
            harness.settings["backup_ok"] = True
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
                self.assertIn("[RECUPERADO]", deliveries[2]["subject"])
                self.assertIn("Duración del incidente: 5 min", deliveries[2]["body"])
                self.assertNotIn("docker logs", deliveries[2]["body"])
                self.assertNotIn("Desplegar", deliveries[2]["body"])
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
                self.assertIn("[RECORDATORIO]", harness.deliveries()[1]["subject"])
                self.assertIn(
                    "Duración del incidente: 360 min", harness.deliveries()[1]["body"]
                )
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(len(harness.deliveries()), 2)

    def test_transient_http_failure_does_not_send_mail(self) -> None:
        for watch in WATCHES:
            with self.subTest(watch=watch), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), watch)
                harness.settings.update(failure="public", blip=True)
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(harness.deliveries(), [])
                counts = json.loads((harness.root / "probes.json").read_text())
                public_counts = [n for url, n in counts.items() if "playground." in url]
                self.assertEqual(public_counts, [2])

    def test_alert_explains_http_error_and_local_time_without_response_data(
        self,
    ) -> None:
        for watch in WATCHES:
            with self.subTest(watch=watch), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), watch)
                harness.settings["failure"] = "public"
                self.assertEqual(harness.run().returncode, 0)
                message = harness.deliveries()[0]
                self.assertIn("[ALERTA]", message["subject"])
                self.assertIn("HTTP 503; curl 0", message["body"])
                self.assertIn("0.125 s; intento 2/2", message["body"])
                self.assertIn(
                    "2027-01-15 03:00:00 Lima / 2027-01-15 08:00:00 UTC",
                    message["body"],
                )
                self.assertNotIn("synthetic private response", message["body"])
                self.assertNotIn("synthetic-key", message["body"])
                if watch == "aule-watch.sh":
                    self.assertIn("La página local respondió", message["body"])
                    self.assertIn("12/13", message["body"])
                else:
                    self.assertIn("3/4", message["body"])
                # A different diagnostic does not restart the incident or spam mail.
                harness.settings.update(http_code="502", now=1_800_000_300)
                self.assertEqual(harness.run().returncode, 0)
                self.assertEqual(len(harness.deliveries()), 1)

    def test_network_errors_are_classified_without_copying_stderr(self) -> None:
        for code, reason in ((6, "DNS"), (28, "tiempo de espera"), (60, "TLS")):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), "aule-watch-outside.sh")
                harness.settings.update(
                    failure="public", http_code="000", curl_code=code
                )
                self.assertEqual(harness.run().returncode, 0)
                body = harness.deliveries()[0]["body"]
                self.assertIn(f"HTTP 000; curl {code}", body)
                self.assertIn(reason, body)
                self.assertNotIn("synthetic private response", body)

    def test_unsent_alert_keeps_start_time_when_delivery_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = WatchHarness(Path(directory), "aule-watch-outside.sh")
            harness.settings.update(failure="public", mail_ok=False)
            self.assertNotEqual(harness.run().returncode, 0)
            self.assertEqual(harness.snapshot(), (None, None))
            harness.settings.update(mail_ok=True, now=1_800_000_600)
            self.assertEqual(harness.run().returncode, 0)
            self.assertIn(
                "Duración del incidente: 10 min", harness.deliveries()[1]["body"]
            )

    def test_unsent_alert_that_recovers_does_not_send_spurious_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = WatchHarness(Path(directory), "aule-watch-outside.sh")
            harness.settings.update(failure="public", mail_ok=False)
            self.assertNotEqual(harness.run().returncode, 0)
            harness.settings.update(failure="", mail_ok=True, now=1_800_000_300)
            self.assertEqual(harness.run().returncode, 0)
            self.assertEqual(len(harness.deliveries()), 1)

    def test_upgrade_and_invalid_timestamps_do_not_invent_a_start_time(self) -> None:
        for stamp in (None, "garbled", "0899999999", "1999999999"):
            with self.subTest(stamp=stamp), tempfile.TemporaryDirectory() as directory:
                harness = WatchHarness(Path(directory), "aule-watch-outside.sh")
                harness.state.write_text("old incident\n")
                if stamp is not None:
                    Path(str(harness.state) + ".since").write_text(stamp)
                    harness.last_mail.write_text(stamp)
                self.assertEqual(harness.run().returncode, 0)
                message = harness.deliveries()[0]
                self.assertIn("[RECUPERADO]", message["subject"])
                self.assertIn("Inicio observado: no registrado", message["body"])
                self.assertIn("Duración del incidente: no registrada", message["body"])

    def test_disk_threshold_and_queue_count_are_actionable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = WatchHarness(Path(directory), "aule-watch.sh")
            harness.settings.update(disk=85, reports="9")
            self.assertEqual(harness.run().returncode, 0)
            message = harness.deliveries()[0]
            self.assertIn("(+1)", message["subject"])
            self.assertIn("85 % usado; umbral: 85 %", message["body"])
            self.assertIn("9 trabajos atrasados o sin reintentos", message["body"])

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
