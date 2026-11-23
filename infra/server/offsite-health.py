#!/usr/bin/env python3
"""Publish only backup freshness and integrity, never paths or database content."""

import hashlib
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

NAME = re.compile(r"aule-\d{8}T\d{6}Z\.sql\.gz(?:\.gpg)?\Z")
MAX_SOURCE_AGE = 7 * 3600
MAX_CHECK_AGE = 26 * 3600


def verify(root: Path, now: float) -> float:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("missing_backup")
    backups = [
        path
        for path in root.glob("*/*.sql.gz*")
        if NAME.fullmatch(path.name)
        and not path.is_symlink()
        and not path.parent.is_symlink()
        and path.is_file()
    ]
    if not backups:
        raise ValueError("missing_backup")
    newest = max(backups, key=lambda path: path.stat().st_mtime)
    before = newest.stat()
    if not 0 <= now - before.st_mtime <= MAX_SOURCE_AGE:
        raise ValueError("stale_backup")
    if before.st_size < 4096:
        raise ValueError("small_backup")
    sidecar = newest.with_name(newest.name + ".sha256")
    if sidecar.is_symlink() or sidecar.stat().st_size > 1024:
        raise ValueError("invalid_checksum")
    match = re.fullmatch(
        r"([0-9a-f]{64}) [ *]" + re.escape(newest.name) + r"\n?", sidecar.read_text()
    )
    if not match:
        raise ValueError("invalid_checksum")
    with newest.open("rb") as stream:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    after = newest.stat()
    if checksum.hexdigest() != match[1] or (
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("checksum_mismatch")
    return before.st_mtime


def publish(root: Path, destination: Path, pull_exit: int, now: float) -> bool:
    report = {"version": 1, "ok": False, "verified_at": now, "backup_at": None}
    try:
        if pull_exit != 0:
            raise ValueError("pull_failed")
        report["backup_at"] = verify(root, now)
        report["ok"] = True
    except (OSError, UnicodeError, ValueError):
        # No filename, checksum, exception text or backup contents leaves this user.
        pass
    descriptor, name = tempfile.mkstemp(prefix=".health-", dir=destination.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(report, stream)
            stream.write("\n")
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return report["ok"]


def healthy(path: Path, now: float) -> bool:
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return False
        report = json.loads(path.read_text())
        return (
            report["version"] == 1
            and report["ok"] is True
            and type(report["verified_at"]) in (int, float)
            and type(report["backup_at"]) in (int, float)
            and 0 <= now - report["verified_at"] <= MAX_CHECK_AGE
            and 0 <= now - report["backup_at"] <= MAX_CHECK_AGE + MAX_SOURCE_AGE
        )
    except (OSError, UnicodeError, ValueError, KeyError, TypeError):
        return False


def main() -> int:
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "check":
            return 0 if healthy(Path(sys.argv[2]), time.time()) else 1
        if len(sys.argv) == 5 and sys.argv[1] == "publish":
            return (
                0
                if publish(
                    Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]), time.time()
                )
                else 1
            )
    except (OSError, ValueError):
        pass
    return 1


if __name__ == "__main__":
    sys.exit(main())
