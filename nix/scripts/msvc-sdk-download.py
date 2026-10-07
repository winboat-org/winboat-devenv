"""Fetch the verified SDK subset from byte ranges in the locked EWDK image."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path, PurePosixPath
import ssl
import time
from urllib.request import Request, urlopen


MAX_RANGE = 8 * 1024 * 1024
MAX_GAP = 128 * 1024


def safe_path(root, name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("unsafe SDK member path")
    return root.joinpath(*path.parts)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ranges(manifest):
    pieces = []
    for file in manifest["files"]:
        cursor = 0
        for extent in file["extents"]:
            offset, size = extent["offset"], extent["size"]
            if offset < 0 or size <= 0 or offset + size > manifest["media"]["size"]:
                raise ValueError("SDK extent exceeds locked media")
            while size:
                take = min(size, MAX_RANGE)
                pieces.append((offset, offset + take, file["path"], cursor))
                offset += take
                cursor += take
                size -= take
        if cursor != file["size"]:
            raise ValueError("SDK extents differ from file size")
    groups = []
    for piece in sorted(pieces):
        start, end, *_ = piece
        if groups and start <= groups[-1][1] + MAX_GAP and max(end, groups[-1][1]) - groups[-1][0] <= MAX_RANGE:
            groups[-1][1] = max(end, groups[-1][1])
            groups[-1][2].append(piece)
        else:
            groups.append([start, end, [piece]])
    return groups


def extract(manifest, output, media=None):
    if manifest["schemaVersion"] != 1 or manifest["kind"] != "winboat-msvc-sdk-subset":
        raise ValueError("unsupported SDK subset")
    output.mkdir(parents=True, exist_ok=False)
    seen = set()
    for directory in manifest["emptyDirectories"]:
        safe_path(output, directory).mkdir(parents=True, exist_ok=True)
    for file in manifest["files"]:
        if file["path"] in seen:
            raise ValueError("duplicate SDK member")
        seen.add(file["path"])
        path = safe_path(output, file["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as target:
            target.truncate(file["size"])
    if media and (media.stat().st_size != manifest["media"]["size"] or file_hash(media) != manifest["media"]["sha256"]):
        raise ValueError("locked EWDK media digest mismatch")

    def transfer(group):
        start, end, pieces = group
        if media:
            with media.open("rb") as source:
                source.seek(start)
                data = source.read(end - start)
        else:
            trust = os.environ.get("SSL_CERT_FILE")
            context = ssl.create_default_context(cafile=trust if trust else None)
            request = Request(manifest["media"]["url"], headers={
                "Range": f"bytes={start}-{end - 1}", "Accept-Encoding": "identity",
                "User-Agent": "WinBoat-SDK-subset/1",
            })
            for attempt in range(3):
                try:
                    with urlopen(request, timeout=45, context=context) as response:
                        expected_range = f"bytes {start}-{end - 1}/{manifest['media']['size']}"
                        if response.status != 206 or response.headers.get("Content-Range") != expected_range:
                            raise ValueError("SDK server did not honor the exact byte range")
                        data = response.read(end - start + 1)
                    if len(data) < end - start:
                        raise OSError("SDK range length mismatch")
                    if len(data) > end - start:
                        raise ValueError("SDK range length mismatch")
                    break
                except (OSError, TimeoutError, IncompleteRead):
                    if attempt == 2:
                        raise
                    time.sleep(2 ** attempt)
        if len(data) != end - start:
            raise ValueError("SDK range length mismatch")
        for begin, limit, name, file_offset in pieces:
            part = memoryview(data)[begin - start:limit - start]
            fd = os.open(safe_path(output, name), os.O_WRONLY)
            try:
                while part:
                    written = os.pwrite(fd, part, file_offset)
                    if written <= 0:
                        raise OSError("short SDK file write")
                    part = part[written:]
                    file_offset += written
            finally:
                os.close(fd)
        return len(data)

    groups = ranges(manifest)
    fetched = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for index, size in enumerate(pool.map(transfer, groups), 1):
            fetched += size
            if index % 32 == 0 or index == len(groups):
                print(f"SDK ranges {index}/{len(groups)}: {fetched} bytes read", flush=True)
    for file in manifest["files"]:
        path = safe_path(output, file["path"])
        if path.stat().st_size != file["size"] or file_hash(path) != file["sha256"]:
            raise ValueError("SDK member digest mismatch: " + file["path"])
    print(json.dumps({"state": "verified-sdk-subset", "members": len(seen), "bytesRead": fetched,
                      "imageBytes": manifest["media"]["size"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--media", type=Path)
    args = parser.parse_args()
    extract(json.loads(args.manifest.read_text()), args.output, args.media)
