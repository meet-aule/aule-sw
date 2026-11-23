"""Synthetic encrypted-copy files only; no backup contents or remote connections."""

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "offsite_health", Path(__file__).with_name("offsite-health.py")
)
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)
NOW = 1_800_000_000


class OffsiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backups = self.root / "backups"
        day = self.backups / "2026-11-23"
        day.mkdir(parents=True)
        self.backup = day / "aule-20261123T120000Z.sql.gz.gpg"
        self.backup.write_bytes(b"synthetic ciphertext" * 512)
        os.utime(self.backup, (NOW - 60, NOW - 60))
        self.sidecar = self.backup.with_name(self.backup.name + ".sha256")
        self.sidecar.write_text(
            hashlib.sha256(self.backup.read_bytes()).hexdigest()
            + "  "
            + self.backup.name
            + "\n"
        )
        self.report = self.root / "latest.json"

    def publish(self, status: int = 0) -> bool:
        return health.publish(self.backups, self.report, status, NOW)

    def test_valid_copy_exposes_only_health_and_expires(self) -> None:
        self.assertTrue(self.publish())
        self.assertTrue(health.healthy(self.report, NOW))
        self.assertTrue(health.healthy(self.report, NOW + 26 * 3600))
        self.assertFalse(health.healthy(self.report, NOW + 26 * 3600 + 1))
        self.assertEqual(
            set(json.loads(self.report.read_text())),
            {"version", "ok", "verified_at", "backup_at"},
        )
        self.assertEqual(self.report.stat().st_mode & 0o777, 0o644)
        self.assertNotIn(self.backup.name, self.report.read_text())

    def test_failed_pull_replaces_previous_success(self) -> None:
        self.assertTrue(self.publish())
        self.assertFalse(self.publish(23))
        self.assertFalse(health.healthy(self.report, NOW))

    def test_corruption_and_missing_checksum_fail(self) -> None:
        self.backup.write_bytes(b"corrupted ciphertext" * 512)
        os.utime(self.backup, (NOW - 60, NOW - 60))
        self.assertFalse(self.publish())
        self.sidecar.unlink()
        self.assertFalse(self.publish())

    def test_old_future_and_small_backups_fail(self) -> None:
        for modified in (NOW - 7 * 3600 - 1, NOW + 1):
            os.utime(self.backup, (modified, modified))
            self.assertFalse(self.publish())
        self.backup.write_bytes(b"cut off")
        os.utime(self.backup, (NOW - 60, NOW - 60))
        self.assertFalse(self.publish())

    def test_symlinks_and_checksum_for_another_file_fail(self) -> None:
        saved = self.backup.with_suffix(".saved")
        self.backup.rename(saved)
        self.backup.symlink_to(saved)
        self.assertFalse(self.publish())
        self.backup.unlink()
        saved.rename(self.backup)
        self.sidecar.write_text("0" * 64 + "  another.sql.gz.gpg\n")
        self.assertFalse(self.publish())

    def test_missing_or_malformed_status_fails_closed(self) -> None:
        self.assertFalse(health.healthy(self.report, NOW))
        for value in ("not json", "null", "[]", "{}", '{"ok":true}'):
            self.report.write_text(value)
            self.assertFalse(health.healthy(self.report, NOW))
        self.publish()
        self.assertFalse(health.healthy(self.report, NOW - 1))


if __name__ == "__main__":
    unittest.main()
