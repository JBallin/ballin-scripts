"""Snapshot only the owned raw coverage directory; never execute a test or report."""
import hashlib, json, os, sys, tarfile, time
from pathlib import Path

def digest_file(filename):
    digest = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.bytes = 0

    def read(self, size=-1):
        data = self.stream.read(size)
        self.digest.update(data)
        self.bytes += len(data)
        return data

def retain(root, output):
    raw = root / "coverage" / "tmp"
    assert not raw.is_symlink() and not output.is_symlink()
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    if not raw.exists():
        result = {"rawPresent": False, "profiles": [], "snapshotComplete": True}
    else:
        assert raw.is_dir()
        files = sorted(raw.iterdir())
        assert all(file.is_file() and not file.is_symlink() for file in files)
        archive_path = output / "raw-profiles.tar.gz"
        records = []
        with tarfile.open(archive_path, "w:gz") as archive:
            for file in files:
                with file.open("rb") as stream:
                    before = os.fstat(stream.fileno())
                    info = archive.gettarinfo(str(file), arcname=file.name)
                    assert info.size == before.st_size
                    reader = HashingReader(stream)
                    archive.addfile(info, reader)
                    after = os.fstat(stream.fileno())
                records.append({"name": file.name, "bytes": reader.bytes,
                    "sha256": reader.digest.hexdigest(),
                    "sourceStableDuringSnapshot": (before.st_ino, before.st_size, before.st_mtime_ns)
                        == (after.st_ino, after.st_size, after.st_mtime_ns)})
        result = {"rawPresent": True, "profiles": records,
                  "archive": archive_path.name, "archiveBytes": archive_path.stat().st_size,
                  "archiveSha256": digest_file(archive_path),
                  "snapshotComplete": all(row["sourceStableDuringSnapshot"] for row in records)}
    result.update({"source": str(raw), "elapsedSeconds": time.monotonic() - started,
                   "scope": "observed terminal-time snapshot; detached descendants not verified",
                   "rawParsingOrCoverageConversion": False})
    (output / "raw-manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    assert result["snapshotComplete"], "Raw source changed during snapshot; retention incomplete"
    return result

if __name__ == "__main__":
    assert len(sys.argv) == 3
    print(json.dumps(retain(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())))
