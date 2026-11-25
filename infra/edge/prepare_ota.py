#!/usr/bin/env python3
"""Verify a reviewed firmware release and prepare the Worker's static assets."""

import argparse
import hashlib
import json
import re
import struct
from pathlib import Path

MODEL = "aule-v0.2"


def prepare(release: Path, version: str, output: Path) -> dict:
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Expected a numeric release version")
    name = f"{MODEL}-{version}.ota.bin"
    data = (release / name).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    sums = [line.split() for line in (release / "SHA256SUMS").read_text().splitlines()]
    matching = [parts[0] for parts in sums if len(parts) == 2 and parts[1] == name]
    if matching != [digest]:
        raise ValueError("Missing, duplicated or incorrect OTA checksum")
    if len(data) < 288 or data[0] != 0xE9 or struct.unpack_from("<I", data, 32)[0] != 0xABCD5432:
        raise ValueError("Expected an application image; never upload the full flash image")
    if struct.unpack_from("<H", data, 12)[0] != 9:
        raise ValueError("Expected ESP32-S3 firmware")
    descriptor = data[32:288]
    if descriptor[16:48].split(b"\0")[0].decode() != version or descriptor[48:80].split(b"\0")[0] != b"xiaozhi":
        raise ValueError("Application version/project does not match the release")
    manifest = {"model": MODEL, "version": version, "path": f"/firmware/{name}", "sha256": digest, "size": len(data)}
    target = output / "firmware" / name
    if target.exists() and target.read_bytes() != data:
        raise ValueError("Cannot replace a published version with different bytes")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    # Keep previous immutable images for devices that already received their URL.
    temporary = output / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(output / "manifest.json")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / ".ota-assets")
    args = parser.parse_args()
    print(json.dumps(prepare(args.release_dir, args.version, args.output), indent=2))
