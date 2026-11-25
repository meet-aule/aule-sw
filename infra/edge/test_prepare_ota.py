import hashlib
import struct
import tempfile
import unittest
from pathlib import Path

from prepare_ota import prepare


class PrepareOtaTests(unittest.TestCase):
    def release(self, root: Path, version: str = "0.0.2", chip: int = 9) -> Path:
        folder = root / version
        folder.mkdir()
        data = bytearray(400)
        data[0] = 0xE9
        struct.pack_into("<H", data, 12, chip)
        struct.pack_into("<I", data, 32, 0xABCD5432)
        data[48:48 + len(version)] = version.encode()
        data[80:87] = b"xiaozhi"
        name = f"aule-v0.2-{version}.ota.bin"
        (folder / name).write_bytes(data)
        (folder / "SHA256SUMS").write_text(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
        return folder

    def test_verified_image_and_immutable_old_version_survive_next_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "assets"
            first = prepare(self.release(root), "0.0.2", output)
            second = prepare(self.release(root, "0.0.3"), "0.0.3", output)
            self.assertNotEqual(first["sha256"], second["sha256"])
            self.assertTrue((output / first["path"].lstrip("/")).exists())
            self.assertTrue((output / second["path"].lstrip("/")).exists())

    def test_invalid_checksums_chip_and_factory_image_cannot_change_manifest(self):
        for mistake in ("checksum", "chip", "factory", "version", "duplicate"):
            with self.subTest(mistake=mistake), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                release = self.release(root, chip=5 if mistake == "chip" else 9)
                image = release / "aule-v0.2-0.0.2.ota.bin"
                sums = release / "SHA256SUMS"
                if mistake in ("factory", "version"):
                    data = bytearray(image.read_bytes())
                    if mistake == "factory":
                        data[32:36] = bytes(4)
                    else:
                        data[48:53] = b"0.0.9"
                    image.write_bytes(data)
                    sums.write_text(f"{hashlib.sha256(data).hexdigest()}  {image.name}\n")
                elif mistake == "checksum":
                    image.write_bytes(image.read_bytes() + b"corrupt")
                elif mistake == "duplicate":
                    sums.write_text(sums.read_text() * 2)
                with self.assertRaises(ValueError):
                    prepare(release, "0.0.2", root / "assets")
                self.assertFalse((root / "assets/manifest.json").exists())

    def test_cannot_replace_existing_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release = self.release(root)
            manifest = prepare(release, "0.0.2", root / "assets")
            (root / "assets" / manifest["path"].lstrip("/")).write_bytes(b"existing")
            with self.assertRaisesRegex(ValueError, "replace"):
                prepare(release, "0.0.2", root / "assets")


if __name__ == "__main__":
    unittest.main()
