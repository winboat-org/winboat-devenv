"""Windows transport boundaries; live acceptance is a separate guest run."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from wb import windows
from wb.common import Failure, digest


class WindowsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wb windows spaces ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ws = SimpleNamespace(state=self.root / "state", resolve=lambda p: Path(p).resolve())

    def test_upload_rejects_corruption_and_concurrent_source_change(self):
        source = self.root / "quotes ' source.ps1"
        source.write_text("exit 0")
        with patch.object(windows, "_sftp"), patch.object(windows, "remote_file", return_value={"sha256": "0"*64, "size": source.stat().st_size}):
            with self.assertRaises(Failure) as error:
                windows.upload(self.ws, "one", source, r"C:\fixture.ps1")
            self.assertEqual(error.exception.code, 74)
        expected = {"sha256": digest(source), "size": source.stat().st_size}
        def changed(*args):
            source.write_text("exit 1")
        with patch.object(windows, "_sftp", side_effect=changed), patch.object(windows, "remote_file", return_value=expected):
            with self.assertRaises(Failure):
                windows.upload(self.ws, "one", source, r"C:\fixture.ps1")

    def test_download_mismatch_never_publishes_output_and_preserves_existing(self):
        output = self.root / "output.dll"
        expected = {"sha256": "0"*64, "size": 5}
        def corrupt(ws, name, local, remote, direction):
            Path(local).write_bytes(b"wrong")
        with patch.object(windows, "_sftp", side_effect=corrupt), patch.object(windows, "remote_file", return_value=expected):
            with self.assertRaises(Failure):
                windows.download(self.ws, "one", r"C:\output.dll", output)
        self.assertFalse(output.exists())
        self.assertEqual(len(list(self.root.glob("*.partial-*"))), 1)
        output.write_bytes(b"existing")
        with patch.object(windows, "remote_file", return_value=expected):
            with self.assertRaises(Failure):
                windows.download(self.ws, "one", r"C:\output.dll", output)
        self.assertEqual(output.read_bytes(), b"existing")

    def test_install_preflight_rejects_tampering_and_windows_aliases_before_transport(self):
        file = self.root / "fixture.dll"
        file.write_bytes(b"original")
        manifest = self.root / "manifest.json"
        value = {"schemaVersion": 1, "fixtureId": "acceptance", "files": [{"path": "fixture.dll", "sha256": digest(file), "size": file.stat().st_size}]}
        manifest.write_text(json.dumps(value))
        file.write_bytes(b"changed!")
        with patch.object(windows, "submit") as submit:
            with self.assertRaises(Failure) as error:
                windows.install(self.ws, "one", manifest, "op-"+"a"*32, fixture=True)
            self.assertEqual(error.exception.code, 74)
            submit.assert_not_called()
        for path in ["../escape", "C:/absolute", "file:stream", "NUL", "dir/CON.txt", "dir/name.", "dir/name ", "file\nname"]:
            with self.subTest(path=path), self.assertRaises(Failure):
                windows.windows_relative(path)

    def test_task_ids_and_real_reboot_codes(self):
        for value in ["op-../outside", "bad", "op-"+"G"*32]:
            with self.assertRaises(Failure):
                windows.job_id(value)
        receipt = {"state": "reboot-required", "exitCode": 3010}
        with patch.object(windows, "job", return_value=receipt):
            self.assertEqual(windows.wait(self.ws, "one", "op-"+"a"*32, allow_reboot=True), receipt)
            with self.assertRaises(Failure) as error:
                windows.wait(self.ws, "one", "op-"+"a"*32)
            self.assertEqual(error.exception.code, 3010)


if __name__ == "__main__":
    unittest.main(verbosity=2)
