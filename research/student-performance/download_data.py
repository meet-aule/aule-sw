"""Download the pinned, public UCI archive; never connect to an Aule service."""

import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent


def main() -> None:
    source = json.loads((ROOT / "source.json").read_text())
    with urlopen(source["url"], timeout=60) as response:
        archive = response.read(2_000_001)
    if hashlib.sha256(archive).hexdigest() != source["sha256"]:
        raise ValueError(
            "UCI archive changed: review its provenance before updating the pin"
        )
    with (
        ZipFile(io.BytesIO(archive)) as outer,
        ZipFile(io.BytesIO(outer.read("student.zip"))) as inner,
    ):
        files = {
            name: inner.read(name)
            for name in ("student-mat.csv", "student-por.csv", "student.txt")
        }
    data = ROOT / "data"
    data.mkdir(exist_ok=True)
    for name, content in files.items():
        (data / name).write_bytes(content)
    print("Verified UCI SHA-256; downloaded two datasets and their description")


if __name__ == "__main__":
    main()
