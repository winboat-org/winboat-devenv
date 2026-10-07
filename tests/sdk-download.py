"""Exercise range extraction and rejection of invalid SDK responses."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("sdk", Path(__file__).parent.parent / "nix/scripts/msvc-sdk-download.py")
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "sdk"
        self.media = b"prefix--" + b"header-data" + b"gap" + b"library-data"
        self.mode = "valid"
        self.requests = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests += 1
                begin, end = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
                data = outer.media[begin:end + 1]
                status = 200 if outer.mode == "ignore-range" else 206
                if outer.mode == "corrupt":
                    data = bytes([data[0] ^ 1]) + data[1:]
                if outer.mode == "short" or (outer.mode == "short-once" and outer.requests == 1):
                    data = data[:-1]
                self.send_response(status)
                if outer.mode != "ignore-range":
                    total = len(outer.media) + (1 if outer.mode == "wrong-image" else 0)
                    self.send_header("Content-Range", f"bytes {begin}-{end}/{total}")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.manifest = {
            "schemaVersion": 1, "kind": "winboat-msvc-sdk-subset",
            "media": {"url": f"http://127.0.0.1:{self.server.server_port}/media", "size": len(self.media)},
            "emptyDirectories": ["empty"],
            "files": [
                {"path": "sdk/include/test.h", "size": 11,
                 "sha256": hashlib.sha256(b"header-data").hexdigest(),
                 "extents": [{"offset": 8, "size": 11}]},
                {"path": "crt/lib/test.lib", "size": 12,
                 "sha256": hashlib.sha256(b"library-data").hexdigest(),
                 "extents": [{"offset": 22, "size": 12}]},
                {"path": "sdk/include/alias.h", "size": 11,
                 "sha256": hashlib.sha256(b"header-data").hexdigest(),
                 "extents": [{"offset": 8, "size": 11}]},
                {"path": "empty-file", "size": 0,
                 "sha256": hashlib.sha256(b"").hexdigest(), "extents": []},
            ],
        }

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def test_extracts_overlapping_members_and_empty_entries(self):
        sdk.extract(self.manifest, self.output)
        self.assertEqual((self.output / "sdk/include/test.h").read_bytes(), b"header-data")
        self.assertEqual((self.output / "sdk/include/alias.h").read_bytes(), b"header-data")
        self.assertEqual((self.output / "crt/lib/test.lib").read_bytes(), b"library-data")
        self.assertEqual((self.output / "empty-file").read_bytes(), b"")
        self.assertTrue((self.output / "empty").is_dir())

    def test_corrupt_member_is_rejected(self):
        self.mode = "corrupt"
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            sdk.extract(self.manifest, self.output)

    def test_ignored_range_is_rejected(self):
        self.mode = "ignore-range"
        with self.assertRaisesRegex(ValueError, "exact byte range"):
            sdk.extract(self.manifest, self.output)

    def test_wrong_image_extent_is_rejected(self):
        self.mode = "wrong-image"
        with self.assertRaisesRegex(ValueError, "exact byte range"):
            sdk.extract(self.manifest, self.output)

    def test_short_response_is_rejected(self):
        self.mode = "short"
        with self.assertRaisesRegex(OSError, "length mismatch"):
            sdk.extract(self.manifest, self.output)
        self.assertEqual(self.requests, 3)

    def test_transient_short_response_is_retried_and_verified(self):
        self.mode = "short-once"
        sdk.extract(self.manifest, self.output)
        self.assertEqual(self.requests, 2)
        self.assertEqual((self.output / "sdk/include/test.h").read_bytes(), b"header-data")
        self.assertEqual((self.output / "crt/lib/test.lib").read_bytes(), b"library-data")

    def test_member_cannot_escape_output(self):
        self.manifest["files"][0]["path"] = "../outside"
        with self.assertRaisesRegex(ValueError, "unsafe SDK member"):
            sdk.extract(self.manifest, self.output)
        self.assertFalse((self.output.parent / "outside").exists())

    def test_source_extents_cannot_exceed_media(self):
        self.manifest["files"][0]["extents"][0]["offset"] = len(self.media)
        with self.assertRaisesRegex(ValueError, "exceeds locked media"):
            sdk.extract(self.manifest, self.output)


if __name__ == "__main__":
    unittest.main()
