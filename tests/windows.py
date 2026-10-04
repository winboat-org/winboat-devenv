"""Windows transport boundaries; live acceptance is a separate guest run."""
import json
import os
from pathlib import Path
import tempfile
import struct
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
import zipfile
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

    def test_empty_image_receipt_recovers_package_without_accepting_native_outputs(self):
        path = self.root / 'images.json'
        path.write_bytes(b'')
        self.assertEqual(windows.read_image_inspections(path, 'helios-development-package', ['bundle/manifest.json']), [])
        self.assertEqual(path.read_bytes(), b'')
        for target, outputs in [('helios-guest-x64', ['package/driver.sys']),
                                ('helios-development-package', ['package/driver.sys'])]:
            with self.subTest(target=target), self.assertRaises(Failure) as error:
                windows.read_image_inspections(path, target, outputs)
            self.assertEqual(error.exception.code, 74)
        path.write_text('[]')
        self.assertEqual(windows.read_image_inspections(path, 'helios-development-package', ['bundle/manifest.json']), [])

    def test_full_install_refuses_incomplete_package_before_guest_side_effects(self):
        files = []
        for name in ['Install-Helios.ps1','Uninstall-Helios.ps1','Verify-Helios.ps1','Helios-PackageCommon.ps1']:
            path = self.root/name; path.write_text('exit 0')
            files.append({'path': name, 'size': path.stat().st_size, 'sha256': digest(path)})
        manifest = self.root/'manifest.json'
        manifest.write_text(json.dumps({'schemaVersion': 1, 'architecture': 'x64', 'applicationArchitectures': ['x64','x86'],
            'signing': {'mode': 'test','certificate': 'certificate/test.cer'}, 'source': {'helios': 'a'*40}, 'files': files}))
        with patch.object(windows, 'submit') as submit, self.assertRaises(Failure) as error:
            windows.install(self.ws, 'one', manifest, 'op-'+'b'*32)
        self.assertEqual(error.exception.code, 2)
        self.assertIn('payload/driver/helios_kmd_render.sys', error.exception.details['missing'])
        submit.assert_not_called()

    def test_tool_mirror_reuse_requires_same_guest_exact_files_and_success(self):
        store=self.root/'fixture-tool'; store.mkdir()
        tool=store/'tool.exe'; tool.write_bytes(b'fixture executable')
        built=[{'drvPath': 'fixture-only.drv', 'outputs': {'out': str(store)}}]
        previous=self.ws.state/'windows-tools'/('op-'+'c'*32); previous.mkdir(parents=True)
        (previous/'nix-build.json').write_text(json.dumps(built))
        snapshot=previous/'snapshot.json'
        snapshot.write_text(json.dumps({'files': [{'path': 'tool.exe','sha256': digest(tool),'size': tool.stat().st_size}]}))
        guest=self.root/'guest'; original=guest/'windows-jobs'/previous.name/'job.json'; original.parent.mkdir(parents=True)
        job={'guestIdentity':'one','metadata': {'toolKind':'utilities'},
            'transfers': [{'remote': 'C:\\fixture\\snapshot.json','sha256':digest(snapshot)}]}
        original.write_text(json.dumps(job))
        environment={'WB_NIX': 'fixture-nix','WB_WINDOWS_UTILITIES_EXPRESSION':'fixture.nix','WB_NIXPKGS':'fixture-only','WB_DEVBOX_PAYLOADS':str(self.root/'payloads')}
        with patch.dict(os.environ,environment), patch.object(windows,'connection',return_value=(guest,{'identity':'one'})), \
             patch.object(windows.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(built))), \
             patch.object(windows,'run',return_value=SimpleNamespace(stdout='fixture-only')), \
             patch.object(windows,'job',return_value={'state':'succeeded'}), patch.object(windows,'submit') as submit, \
             patch.object(windows,'wait'):
            reused=windows.mirror_build_tools(self.ws,'one','utilities')
            self.assertEqual(reused['operationId'],previous.name)
            self.assertTrue(reused['reusedVerifiedMirror'])
            submit.assert_not_called()
            job['guestIdentity']='another'; original.write_text(json.dumps(job))
            fresh=windows.mirror_build_tools(self.ws,'one','utilities')
            self.assertNotEqual(fresh['operationId'],previous.name)
            submit.assert_called_once()
            submit.reset_mock(); job['guestIdentity']='one'; original.write_text(json.dumps(job))
            tool.write_bytes(b'changed fixture executable')
            fresh=windows.mirror_build_tools(self.ws,'one','utilities')
            self.assertNotEqual(fresh['operationId'],previous.name)
            submit.assert_called_once()

    def artifact(self, members):
        archive = self.root / "artifact.zip"
        files = []
        with zipfile.ZipFile(archive, "w") as zipped:
            for path, content in members:
                zipped.writestr(path, content)
                files.append({"path": path, "size": len(content), "sha256": __import__("hashlib").sha256(content).hexdigest()})
        return archive, files

    def kernel_fixture(self):
        image = bytearray(1024)
        image[:2] = b'MZ'; struct.pack_into('<I', image, 60, 64)
        image[64:68] = b'PE\0\0'
        struct.pack_into('<HH', image, 68, 0x8664, 2)
        struct.pack_into('<H', image, 84, 240)
        struct.pack_into('<H', image, 88, 0x20b)
        struct.pack_into('<Q', image, 112, 0x140000000)
        struct.pack_into('<I', image, 144, 0x4000)
        struct.pack_into('<II', image, 240, 0x3000, 12)
        image[328:333] = b'.text'
        struct.pack_into('<IIII', image, 336, 16, 0x1000, 16, 512)
        struct.pack_into('<I', image, 364, 0x60000020)
        image[368:374] = b'.reloc'
        struct.pack_into('<IIII', image, 376, 12, 0x3000, 12, 768)
        struct.pack_into('<I', image, 404, 0x42000040)
        struct.pack_into('<Q', image, 512, 0x140001234)
        image[520:528] = b'code1234'
        struct.pack_into('<IIHH', image, 768, 0x1000, 12, 0xa000, 0)
        return image

    def test_kernel_mapping_normalizes_relocations_and_detects_replaced_sys(self):
        original = self.kernel_fixture()
        relocated = bytearray(original[512:528])
        base = 0xfffff80100000000
        struct.pack_into('<Q', relocated, 0, base+0x1234)
        def read(rva, size, section):
            return original[:size] if rva == 0 else relocated
        result = windows.mapped_kernel_identity(original, base, read)
        self.assertEqual(result['state'], 'mapped-code-matches')
        changed = bytearray(original); changed[525] ^= 1
        self.assertEqual(windows.mapped_kernel_identity(changed, base, read)['state'], 'stale-mapped-image')
        with self.assertRaises(Failure):
            windows.mapped_kernel_identity(original, base, lambda *args: b'')

    def test_kernel_mapping_refuses_unsupported_executable_relocations(self):
        image = self.kernel_fixture()
        struct.pack_into('<H', image, 776, 0x3000)
        with self.assertRaises(Failure):
            windows.mapped_kernel_identity(image, 0xfffff80100000000,
                lambda rva,size,section: image[:size] if rva == 0 else image[512:528])

    def test_archive_complete_table_and_resume_preserve_existing_files(self):
        archive, files = self.artifact([("package/test.dll", b"image"), ("licenses/NOTICE", b"notice")])
        destination = self.root / "export" / "files"
        windows.extract_artifact(archive, destination, files)
        image = destination / "package/test.dll"
        original = image.stat().st_mtime_ns
        windows.extract_artifact(archive, destination, files)
        self.assertEqual(image.stat().st_mtime_ns, original)
        image.write_bytes(b"manual drift")
        with self.assertRaises(Failure):
            windows.extract_artifact(archive, destination, files)
        self.assertEqual(image.read_bytes(), b"manual drift")

    def test_windows_archive_separators_match_canonical_file_table(self):
        archive, files = self.artifact([(r"package\test.dll", b"image")])
        files[0]["path"] = "package/test.dll"
        destination = self.root / "files"
        windows.extract_artifact(archive, destination, files)
        self.assertEqual((destination / "package/test.dll").read_bytes(), b"image")

    def test_windows_empty_archive_directory_is_metadata_and_cannot_hide_data(self):
        archive, files = self.artifact([(r"package\test.dll", b"image")])
        files[0]['path'] = 'package/test.dll'
        with zipfile.ZipFile(archive, 'a') as zipped:
            zipped.writestr('licenses\\venus-protocol\\', b'')
        destination = self.root / 'valid' / 'files'
        windows.extract_artifact(archive, destination, files)
        self.assertEqual((destination / 'package/test.dll').read_bytes(), b'image')
        self.assertFalse((destination / 'licenses').exists())
        for name, content, symlink in [
            ('../escape\\', b'', False),
            ('C:\\escape\\', b'', False),
            ('licenses\\notice\\', b'hidden data', False),
            ('package\\test.dll\\', b'', False),
            ('licenses\\link\\', b'', True),
        ]:
            archive, _ = self.artifact([('package/test.dll', b'image')])
            with zipfile.ZipFile(archive, 'a') as zipped:
                entry = zipfile.ZipInfo(name)
                if symlink:
                    entry.create_system = 3
                    entry.external_attr = 0o120777 << 16
                zipped.writestr(entry, content)
            refused = self.root / 'refused' / 'files'
            with self.subTest(name=name), self.assertRaises(Failure):
                windows.extract_artifact(archive, refused, files)
            self.assertFalse(refused.exists())

    def test_source_links_materialize_without_cycles_or_escape(self):
        source = self.root / "source"
        (source / "bin").mkdir(parents=True)
        (source / "bin/tool.py").write_text("build source")
        (source / "ci").mkdir()
        (source / "ci/bin").symlink_to("../bin", target_is_directory=True)
        files, links = windows.windows_source_files(source)
        self.assertEqual({path for path, _ in files}, {"bin/tool.py", "ci/bin/tool.py"})
        self.assertEqual(links, [{"path": "ci/bin", "target": "../bin", "materialized": "directory"}])
        (source / "bin/cycle").symlink_to("..", target_is_directory=True)
        with self.assertRaises(Failure):
            windows.windows_source_files(source)
        (source / "bin/cycle").unlink()
        (source / "outside").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(Failure):
            windows.windows_source_files(source)

    def test_release_dependency_refuses_stale_pin_and_new_worktree_changes(self):
        repository = self.root/'repository'
        repository.mkdir()
        def git(*arguments):
            return subprocess.check_output(['git', '-C', str(repository), *arguments], text=True)
        git('init', '-q')
        (repository/'source.txt').write_text('source')
        git('add', 'source.txt')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        revision = git('rev-parse', 'HEAD').strip()
        workspace = SimpleNamespace(paths={'fixture': repository}, repos={'fixture': {'pin': {'rev': revision}}},
                                    repo_locks=lambda sources: nullcontext())
        manifest = {'sources': {'fixture': {'revision': revision}}}
        with patch.dict(os.environ, {'WB_REAL_GIT': shutil.which('git')}):
            windows.validate_dependency_sources(workspace, manifest, 'release')
            (repository/'source.txt').write_text('changed')
            with self.assertRaises(Failure):
                windows.validate_dependency_sources(workspace, manifest, 'release')
            windows.validate_dependency_sources(workspace, manifest, 'development')
            git('checkout', '--', 'source.txt')
            (repository/'untracked.txt').write_text('new source')
            with self.assertRaises(Failure):
                windows.validate_dependency_sources(workspace, manifest, 'release')
            (repository/'untracked.txt').unlink()
            workspace.repos['fixture']['pin']['rev'] = '0'*40
            with self.assertRaises(Failure):
                windows.validate_dependency_sources(workspace, manifest, 'release')

    def test_concurrent_control_publication_never_reopens_verified_scripts(self):
        source = self.root/'payloads'
        source.mkdir()
        for name in ['Control.ps1','Task.ps1','LoadedIdentity.cs','Toolchain.ps1']:
            (source/name).write_text(name)
        guest_files, opening = {}, set()
        def invoke(*arguments):
            return SimpleNamespace(stdout=json.dumps({'files': list(guest_files.values())}))
        def upload(ws, name, path, remote):
            if path.name in opening or path.name in guest_files:
                raise Failure('script already open', 74)
            opening.add(path.name)
            time.sleep(0.02)
            guest_files[path.name] = {'name':path.name,'sha256':windows.digest(path),'size':path.stat().st_size}
            opening.remove(path.name)
        with patch.dict(os.environ, {'WB_DEVBOX_PAYLOADS':str(source)}), \
                patch.object(windows, 'connection', return_value=(self.root, {'identity':'1'*32})), \
                patch.object(windows, 'invoke', side_effect=invoke), patch.object(windows, 'upload', side_effect=upload) as transfer:
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda ignored: windows.payloads(self.ws,'one'), range(2)))
            self.assertEqual(results[0], results[1])
            self.assertEqual(transfer.call_count, 4)
            guest_files['Toolchain.ps1']['sha256'] = '0'*64
            with self.assertRaises(Failure):
                windows.payloads(self.ws,'one')
            self.assertEqual(transfer.call_count, 4)

    def test_archive_table_errors_fail_before_publishing(self):
        for members, table in [
            ([("../escape", b"x")], [{"path": "safe", "size": 1, "sha256": "0"*64}]),
            ([("safe", b"x"), ("unexpected", b"x")], [{"path": "safe", "size": 1, "sha256": "0"*64}]),
            ([("safe", b"x")], [{"path": "missing", "size": 1, "sha256": "0"*64}]),
            ([("safe", b"x"), ("SAFE", b"x")], [{"path": "safe", "size": 1, "sha256": "0"*64}]),
            ([("safe", b"x")], [{"path": "safe", "size": 2, "sha256": "0"*64}]),
        ]:
            archive, _ = self.artifact(members)
            destination = self.root / "files"
            with self.subTest(members=members), self.assertRaises(Failure):
                windows.extract_artifact(archive, destination, table)
            self.assertFalse(destination.exists())

    def test_archive_corruption_retains_partial_outside_artifact(self):
        archive, files = self.artifact([("package/test.dll", b"wrong")])
        files[0]["sha256"] = "0"*64
        destination = self.root / "export" / "files"
        with self.assertRaises(Failure):
            windows.extract_artifact(archive, destination, files)
        self.assertFalse((destination / "package/test.dll").exists())
        self.assertEqual(len(list(destination.parent.glob("artifact.partial-*"))), 1)
        self.assertEqual(list(destination.rglob("*dll")), [])

    def test_archive_and_destination_symlinks_are_refused(self):
        archive, files = self.artifact([("package/test.dll", b"image")])
        destination = self.root / "export" / "files"
        destination.mkdir(parents=True)
        external = self.root / "external"
        external.mkdir()
        (destination / "package").symlink_to(external, target_is_directory=True)
        with self.assertRaises(Failure):
            windows.extract_artifact(archive, destination, files)
        self.assertEqual(list(external.iterdir()), [])
        link = zipfile.ZipInfo("package/test.dll")
        link.create_system = 3
        link.external_attr = (0o120777 << 16)
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr(link, b"image")
        with self.assertRaises(Failure):
            windows.extract_artifact(archive, self.root / "symlink-export", files)


if __name__ == "__main__":
    unittest.main(verbosity=2)
