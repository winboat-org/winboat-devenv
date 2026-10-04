"""Boundary/resume checks; these do not stand in for live Windows acceptance."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from wb import devbox, graphics
from wb.common import Failure, write_json


class DevboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wb devbox spaces ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "different host workspace"
        self.root.mkdir()
        self.ws = SimpleNamespace(root=self.root, state=self.root / ".state", config={"devbox": {}},
                                  resolve=lambda value: Path(value).resolve(), journal=lambda *args: None)

    def record(self, name="one"):
        record = {"schemaVersion": 1, "name": name, "identity": "a" * 32, "owner": devbox.owner(self.ws, create=True),
                  "ports": {"ssh": 49123, "viewer": 49124}, "image": None,
                  "provisioning": {"phase": "prepared", "verified": False},
                  "hostArtifact": {"manifestSha256": "b" * 64}}
        write_json(devbox.location(self.ws, name) / "devbox.json", record)
        return record

    def test_names_symlinks_and_owner_boundaries(self):
        for name in ["../external", "", "Upper", "one/two"]:
            with self.assertRaises(Failure):
                devbox.location(self.ws, name)
        outside = self.root / "external"
        outside.mkdir()
        (self.ws.state / "devboxes").mkdir(parents=True)
        (self.ws.state / "devboxes/escape").symlink_to(outside)
        with self.assertRaises(Failure):
            devbox.location(self.ws, "escape")
        record = self.record()
        record["owner"] = "c" * 32
        write_json(devbox.location(self.ws, "one") / "devbox.json", record)
        with self.assertRaises(Failure):
            devbox.load(self.ws, "one")

    def test_unattended_identity_image_partition_and_escaped_password(self):
        config = {"diskGiB": 128, "cpus": 4, "memoryMiB": 8192}
        self.assertEqual(devbox.creation_resources(config), (128, 4, 8192))
        self.assertEqual(devbox.creation_resources(config, 512), (512, 4, 8192))
        self.assertEqual(config["diskGiB"], 128)
        self.assertEqual(devbox.creation_resources({}), (128, 4, 8192))
        for size in [True, 63, 2049, "512"]:
            with self.subTest(size=size), self.assertRaises(Failure):
                devbox.creation_resources(config, size)
        root = ET.fromstring(devbox.answer_xml('example<&"secret', 2, "en-US"))
        ns = {"u": "urn:schemas-microsoft-com:unattend"}
        self.assertEqual(root.find(".//u:ComputerName", ns).text, "WB-DEVBOX")
        self.assertEqual(root.find(".//u:LocalAccount/u:Name", ns).text, "wbdev")
        self.assertEqual(root.find(".//u:LocalAccount/u:Password/u:Value", ns).text, 'example<&"secret')
        self.assertEqual(root.find(".//u:MetaData/u:Value", ns).text, "2")
        self.assertEqual(root.find(".//u:InstallTo/u:PartitionID", ns).text, "3")
        self.assertEqual(root.find(".//u:Disk/u:WillWipeDisk", ns).text, "true")
        locale = root.find("u:settings[@pass='oobeSystem']/u:component[@name='Microsoft-Windows-International-Core']/u:UserLocale", ns)
        self.assertEqual(locale.text, "en-US")
        modifications = root.findall(".//u:ModifyPartition", ns)
        self.assertEqual([item.find("u:Order", ns).text for item in modifications], ["1", "2"])
        self.assertEqual([item.find("u:PartitionID", ns).text for item in modifications], ["1", "3"])

    def test_port_collisions_and_explicit_reservation(self):
        record = self.record()
        first = devbox.allocate_ports(self.ws, devbox.location(self.ws, "two"), {})
        self.assertEqual(len(set(first.values())), 2)
        self.assertFalse(set(first.values()) & set(record["ports"].values()))
        with self.assertRaises(Failure):
            devbox.allocate_ports(self.ws, devbox.location(self.ws, "two"), {"sshPort": record["ports"]["ssh"]})

    def test_loaded_observation_is_stale_when_runtime_is_unavailable(self):
        self.record()
        write_json(devbox.location(self.ws, "one") / "host-observation.json", {"state": "running", "loaded": True})
        with patch.object(devbox, "runtime", side_effect=Failure("unavailable", 3)):
            status = devbox.status(self.ws, "one")
        self.assertEqual(status["state"], "runtime-unavailable")
        self.assertFalse(status["loaded"])

    def test_foreign_container_and_changed_image_are_refused(self):
        record = self.record()
        data = {"Config": {"Labels": {"org.winboat.owner": "different", "org.winboat.identity": record["identity"]}}, "Image": "sha256:wrong"}
        with patch.object(devbox, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps([data]), "")):
            with self.assertRaises(Failure):
                devbox.inspect({"command": ["runtime"]}, record)
            data["Config"]["Labels"]["org.winboat.owner"] = record["owner"]
            record["image"] = {"id": "sha256:expected"}
            with self.assertRaises(Failure):
                devbox.inspect({"command": ["runtime"]}, record)

    def test_runtime_binding_survives_config_change_and_refuses_another_daemon(self):
        record = self.record()
        record["runtime"] = {"kind": "docker", "command": ["retained-docker"], "daemonId": "original"}
        self.ws.config["devbox"]["containerRuntime"] = "podman"
        with patch.object(devbox, "bounded", return_value=subprocess.CompletedProcess([], 0, '{"ServerVersion":"29","ID":"original"}', "")) as probe:
            self.assertEqual(devbox.runtime(self.ws, record)["kind"], "docker")
            self.assertEqual(probe.call_args.args[0][0], "retained-docker")
        with patch.object(devbox, "bounded", return_value=subprocess.CompletedProcess([], 0, '{"ServerVersion":"29","ID":"other"}', "")):
            with self.assertRaises(Failure):
                devbox.runtime(self.ws, record)

    def test_legacy_runtime_discovers_owned_container_and_refuses_ambiguity(self):
        record = self.record()
        record["image"] = {"id": "image"}
        candidates = [("docker", ["docker"]), ("podman", ["podman"])]
        with patch.object(devbox, "runtime_candidates", return_value=candidates), \
                patch.object(devbox, "bounded", return_value=subprocess.CompletedProcess([], 0, '{"ServerVersion":"29"}', "")), \
                patch.object(devbox, "inspect", side_effect=lambda rt, record: {} if rt["kind"] == "docker" else {"State": {"Running": False}}):
            self.assertEqual(devbox.runtime(self.ws, record)["kind"], "podman")
        for found in [None, {"State": {"Running": True}}]:
            with patch.object(devbox, "runtime_candidates", return_value=candidates), \
                    patch.object(devbox, "bounded", return_value=subprocess.CompletedProcess([], 0, '{"ServerVersion":"29"}', "")), \
                    patch.object(devbox, "inspect", return_value=found):
                with self.assertRaises(Failure):
                    devbox.runtime(self.ws, record)

    def test_destroy_confirmation_preserves_disk_and_external_paths(self):
        record = self.record()
        disk = devbox.location(self.ws, "one") / "disk.qcow2"
        disk.write_bytes(b"preserve existing guest")
        with self.assertRaises(Failure):
            devbox.destroy(self.ws, "one", "wrong", "operation")
        self.assertEqual(disk.read_bytes(), b"preserve existing guest")
        with patch.object(devbox, "runtime", return_value={"command": ["runtime"]}), patch.object(devbox, "inspect", return_value={"State": {"Running": True}}):
            with self.assertRaises(Failure):
                devbox.destroy(self.ws, "one", record["identity"], "operation")
        self.assertTrue(disk.exists())

    def host_migration_fixture(self):
        record = self.record()
        record['provisioning']['verified'] = True
        record['image'] = {'id': 'old-image', 'archiveSha256': 'c' * 64,
                           'output': '/nix/store/old-archive', 'runtimeRoot': '/nix/store/old-runtime'}
        directory = devbox.location(self.ws, 'one')
        old, new = self.root / 'old-host.json', self.root / 'new-host.json'
        sources = {name: {'revision': 'd' * 40, 'narHash': 'sha256-fixture', 'diffSha256': None}
                   for name in ['qemu-helios', 'virglrenderer', 'venus-protocol']}
        for path in [old, new]:
            write_json(path, {'mode': 'release', 'sources': sources})
        record['hostArtifact']['manifest'] = str(old)
        write_json(directory / 'devbox.json', record)
        for relative, data in [('disk.qcow2', b'guest disk'), ('secrets/ssh', b'guest key'),
                               ('tpm/tpm2-00.permall', b'guest TPM')]:
            path = directory / relative
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
        def artifact(ws, path):
            return {'manifest': str(path), 'manifestSha256': ('b' if Path(path) == old else 'e') * 64,
                    'output': '/nix/store/' + ('old' if Path(path) == old else 'new')}
        return directory, record, new, artifact

    def test_host_migration_refuses_running_guest_and_changed_protocol(self):
        directory, record, new, artifact = self.host_migration_fixture()
        with patch.object(devbox, 'runtime', return_value={'command': ['runtime']}), \
                patch.object(devbox, 'inspect', return_value={'State': {'Running': True}}), \
                patch.object(devbox, 'build_image') as build:
            with self.assertRaises(Failure):
                devbox.migrate_host(self.ws, 'one', str(new), 'running-operation')
            build.assert_not_called()
        data = json.loads(new.read_text())
        data['sources']['venus-protocol']['narHash'] = 'sha256-changed'
        write_json(new, data)
        with patch.object(devbox, 'runtime', return_value={'command': ['runtime']}), \
                patch.object(devbox, 'inspect', return_value=None), \
                patch.object(devbox, 'host_artifact', side_effect=artifact), \
                patch.object(devbox, 'build_image') as build:
            with self.assertRaises(Failure):
                devbox.migrate_host(self.ws, 'one', str(new), 'protocol-operation')
            build.assert_not_called()
        self.assertEqual(json.loads((directory / 'devbox.json').read_text()), record)

    def test_failed_host_migration_preserves_selection_disk_keys_and_tpm(self):
        directory, record, new, artifact = self.host_migration_fixture()
        preserved = {p: (directory / p).read_bytes() for p in ['disk.qcow2', 'secrets/ssh', 'tpm/tpm2-00.permall']}
        with patch.dict(os.environ, {'WB_NIX': 'nix'}), \
                patch.object(devbox, 'runtime', return_value={'command': ['runtime']}), \
                patch.object(devbox, 'inspect', return_value=None), \
                patch.object(devbox, 'host_artifact', side_effect=artifact), \
                patch.object(devbox, 'run') as run, \
                patch.object(devbox, 'build_image', side_effect=Failure('image build failed', 3)):
            with self.assertRaises(Failure):
                devbox.migrate_host(self.ws, 'one', str(new), 'failed-operation')
            self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(json.loads((directory / 'devbox.json').read_text()), record)
        self.assertEqual(json.loads((directory / 'host-migrations/failed-operation/before.json').read_text()), record)
        self.assertEqual({p: (directory / p).read_bytes() for p in preserved}, preserved)

    def test_host_migration_prepares_new_image_with_previous_identity_retained(self):
        directory, record, new, artifact = self.host_migration_fixture()
        stopped = {'Id': 'owned-container', 'State': {'Running': False}}
        with patch.dict(os.environ, {'WB_NIX': 'nix'}), \
                patch.object(devbox, 'runtime', return_value={'command': ['runtime']}), \
                patch.object(devbox, 'inspect', return_value=stopped), \
                patch.object(devbox, 'host_artifact', side_effect=artifact), \
                patch.object(devbox, 'run', return_value=subprocess.CompletedProcess([], 0, 'retained log', '')), \
                patch.object(devbox, 'build_image', return_value={'id': 'new-image'}):
            result = devbox.migrate_host(self.ws, 'one', str(new), 'prepared-operation')
        selected = json.loads((directory / 'devbox.json').read_text())
        self.assertEqual(result['state'], 'prepared')
        self.assertFalse(result['loaded'])
        self.assertEqual(selected['identity'], record['identity'])
        self.assertEqual(selected['image']['id'], 'new-image')
        self.assertEqual(selected['previousHostArtifacts'][0]['hostArtifact'], record['hostArtifact'])
        self.assertEqual(selected['previousHostArtifacts'][0]['image'], record['image'])
        self.assertEqual((directory / 'secrets/ssh').read_bytes(), b'guest key')

    def test_authenticated_shutdown_waits_for_completion_and_preserves_timeout(self):
        record = self.record()
        record['provisioning']['verified'] = True
        directory = devbox.location(self.ws, 'one')
        disk = directory / 'disk.qcow2'; disk.write_bytes(b'keep guest disk')
        write_json(directory / 'devbox.json', record)
        payloads = self.root / 'payloads'; payloads.mkdir()
        (payloads / 'Shutdown.ps1').write_text('shutdown fixture')
        rt = {'kind': 'docker', 'command': ['docker'], 'info': {'ID': 'original'}}
        running = {'State': {'Running': True}}
        stopped = {'State': {'Running': False, 'ExitCode': 0}}
        with patch.dict(os.environ, {'WB_DEVBOX_PAYLOADS': str(payloads)}), \
                patch.object(devbox, 'runtime', return_value=rt), \
                patch.object(devbox, 'ssh_command', return_value=['ssh']), \
                patch.object(devbox, 'bounded', return_value=subprocess.CompletedProcess([], 0, '', '')), \
                patch.object(devbox, 'inspect', side_effect=[running, stopped]), \
                patch.object(devbox, 'qmp_powerdown') as qmp:
            result = devbox.down(self.ws, 'one', 'operation', timeout=10)
            self.assertTrue(result['cleanShutdown'])
            self.assertEqual(result['shutdown']['method'], 'ssh')
            qmp.assert_not_called()
        with patch.dict(os.environ, {'WB_DEVBOX_PAYLOADS': str(payloads)}), \
                patch.object(devbox, 'runtime', return_value=rt), \
                patch.object(devbox, 'ssh_command', return_value=['ssh']), \
                patch.object(devbox, 'bounded', return_value=subprocess.CompletedProcess([], 0, '', '')), \
                patch.object(devbox, 'inspect', return_value=running), \
                patch.object(devbox.time, 'monotonic', side_effect=[0, 11]), \
                patch.object(devbox, 'run') as execute:
            with self.assertRaises(Failure) as failed:
                devbox.down(self.ws, 'one', 'operation', timeout=10)
            self.assertIn('preserved running', str(failed.exception))
            execute.assert_not_called()
        self.assertEqual(disk.read_bytes(), b'keep guest disk')

    def test_cdi_preflight_detects_stale_files_and_wrong_gpu_before_launch(self):
        driver = self.root / 'libEGL_nvidia.so.1'; driver.write_bytes(b'actual installed driver')
        vendor = self.root / '10_nvidia.json'; vendor.write_text('{}')
        hook = self.root / 'nvidia-cdi-hook'; hook.write_bytes(b'vendor hook')
        spec = {'kind': 'nvidia.com/gpu', 'devices': [{'name': 'GPU-fixture', 'containerEdits': {
            'deviceNodes': [{'path': '/dev/dri/renderD128'}]}}], 'containerEdits': {
            'mounts': [{'hostPath': str(driver), 'containerPath': '/usr/lib/libEGL_nvidia.so.1'},
                       {'hostPath': str(vendor), 'containerPath': '/usr/share/glvnd/egl_vendor.d/10_nvidia.json'}],
            'hooks': [{'path': str(hook), 'args': ['create-symlinks', 'lib.so::/usr/lib/gbm/nvidia-drm_gbm.so']}]}}
        directory = self.root / 'cdi'; write_json(directory / 'nvidia.json', spec)
        rt = {'info': {'CDISpecDirs': [str(directory)]}}
        with patch.object(graphics, 'node_identity', return_value={'vendor': '0x10de', 'driver': 'nvidia'}):
            initial = graphics.plan({}, '/dev/dri/renderD128', rt)
            self.assertEqual(initial['cdiDevice'], 'nvidia.com/gpu=GPU-fixture')
            self.assertEqual(initial['inputs'][0]['size'], driver.stat().st_size)
            with self.assertRaises(Failure):
                graphics.plan({}, '/dev/dri/renderD129', rt)
            driver.unlink()
            with self.assertRaises(Failure) as failed:
                graphics.plan({}, '/dev/dri/renderD128', rt)
            self.assertIn(str(driver), failed.exception.details['missing'])

    def test_relocated_state_keeps_ownership_and_defined_guest_defaults(self):
        record = self.record()
        moved = self.root.parent / "relocated workspace with spaces"
        shutil.move(self.root, moved)
        self.ws.root = moved; self.ws.state = moved / ".state"
        self.assertEqual(devbox.load(self.ws, "one")[1]["identity"], record["identity"])
        self.ws.config["devbox"] = {"guestUsername": "different-host-user"}
        with self.assertRaises(Failure):
            devbox.settings(self.ws)

    def test_workspace_cdi_launch_ignores_system_specs_and_refuses_docker(self):
        generated = {'graphics': {'cdiDevice': 'nvidia.com/gpu=GPU-fixture',
                                  'spec': {'path': str(self.ws.state / 'gpu/operation/nvidia.yaml')}},
                     'manifest': str(self.ws.state / 'gpu/operation/manifest.json')}
        with patch.object(graphics, 'node_identity', return_value={'vendor': '0x10de', 'driver': 'nvidia'}), \
                patch.dict(os.environ, {'WB_NVIDIA_CTK': 'pinned-generator', 'WB_NVIDIA_CDI_HOOK': 'pinned-hook',
                                        'WB_CONTAINER_HOOKS_DIR': '/nix/store/no-hooks'}), \
                patch.object(graphics, 'prepare', return_value=generated):
            podman = graphics.launch_plan(self.ws, {}, '/dev/dri/renderD128', {'kind': 'podman'}, 'operation')
            self.assertEqual(podman['runtimeArguments'], ['--cdi-spec-dir', str(self.ws.state / 'gpu/operation'),
                                                        '--hooks-dir', '/nix/store/no-hooks'])
            self.assertEqual(podman['runArguments'], ['--device', 'nvidia.com/gpu=GPU-fixture'])
            rt = {'kind': 'docker', 'info': {}}
            with self.assertRaises(Failure):
                graphics.launch_plan(self.ws, {}, '/dev/dri/renderD128', rt, 'operation')

    def test_malformed_external_cdi_is_a_typed_failure(self):
        for spec in [{'devices': [{}]}, {'devices': None},
                     {'containerEdits': {'mounts': [{'hostPath': '../escape', 'containerPath': '/lib'}]}}]:
            with self.assertRaises(Failure):
                graphics.validate_spec(spec, 'bad-spec.yaml')

    def test_auto_runtime_on_nvidia_requires_private_podman(self):
        with patch.dict(os.environ, {'WB_PODMAN': 'pinned-podman', 'WB_DOCKER': 'pinned-docker'}), \
                patch.object(graphics, 'node_identity', return_value={'vendor': '0x10de', 'driver': 'nvidia'}):
            candidates = devbox.runtime_candidates(self.ws, {'renderNode': '/dev/dri/renderD128'})
            self.assertEqual([kind for kind, _ in candidates], ['podman'])
            # Discovering existing legacy containers still probes both stores.
            legacy = devbox.runtime_candidates(self.ws, {'renderNode': '/dev/dri/renderD128'}, all_kinds=True)
            self.assertEqual([kind for kind, _ in legacy], ['docker', 'podman'])

    def test_offline_lock_rejects_path_escape_and_empty_locked_tool(self):
        path = self.root / 'config/provision.lock.json'
        tool = {'id': 'fixture', 'status': 'locked', 'install': 'install', 'probe': 'probe',
                'payloads': [{'file': 'setup.exe', 'url': 'https://example.invalid/setup.exe',
                              'sha256': '1' * 64, 'relativePath': '../external/setup.exe'}]}
        write_json(path, {'schemaVersion': 1, 'tools': [tool]})
        with self.assertRaises(Failure):
            devbox.provision_lock(self.ws)
        tool['payloads'][0]['relativePath'] = 'Installers/setup.exe'
        write_json(path, {'schemaVersion': 1, 'tools': [tool]})
        self.assertEqual(devbox.provision_lock(self.ws)['unresolved'], [])
        tool['payloads'] = []
        write_json(path, {'schemaVersion': 1, 'tools': [tool]})
        with self.assertRaises(Failure):
            devbox.provision_lock(self.ws)

    def test_changed_prepared_lock_refuses_image_build_before_network(self):
        directory = self.root / 'prepared'
        write_json(directory / 'answer/provision.lock.json', {'changed': True})
        record = {'provisioning': {'lockSha256': '2' * 64}}
        with patch.object(devbox.subprocess, 'run') as execute:
            with self.assertRaises(Failure):
                devbox.build_image(self.ws, directory, record, {})
            execute.assert_not_called()

    def test_interrupted_creation_preserves_keys_and_existing_disk(self):
        media = {"sha256": "d" * 64, "image": {"index": 1}, "locale": "en-US"}
        artifact = {"manifestSha256": "e" * 64, "output": str(self.root / "stack")}
        payloads = self.root / "payloads"; payloads.mkdir()
        (self.root / "config").mkdir()
        (self.root / "config/provision.lock.json").write_text('{}\n')
        stack = Path(artifact["output"]); (stack / "share/qemu").mkdir(parents=True)
        (stack / "share/qemu/edk2-i386-vars.fd").write_bytes(b"firmware")
        args = argparse.Namespace(name="resume", iso="input.iso", manifest="manifest.json", iso_sha256=None,
                                  index=None, edition=None, locale="en-US", start=False)
        def fake_run(command, **kwargs):
            if command[0] == "keygen":
                private = Path(command[command.index("-f") + 1]); private.write_text("private key identity")
                private.with_suffix(private.suffix + ".pub").write_text("ssh-ed25519 public-key identity\n")
            elif command[0] == "xorriso":
                Path(command[command.index("-o") + 1]).write_bytes(b"answer image")
            else:
                Path(command[-2]).write_bytes(b"new disk")
            return subprocess.CompletedProcess(command, 0, "", "")
        environment = {"WB_SSH_KEYGEN": "keygen", "WB_XORRISO": "xorriso", "WB_DEVBOX_PAYLOADS": str(payloads)}
        with patch.dict(os.environ, environment), patch.object(devbox, "host_artifact", return_value=artifact), \
                patch.object(devbox, "media", return_value=media), patch.object(devbox, "provision_lock", return_value={"sha256": "f" * 64, "data": {}, "unresolved": []}), \
                patch.object(devbox, "run", side_effect=fake_run):
            devbox.create(self.ws, args, "operation")
            directory, record = devbox.load(self.ws, "resume")
            (directory / "disk.qcow2").write_bytes(b"installed Windows disk")
            password = (directory / "secrets/password").read_bytes()
            record["provisioning"]["phase"] = "initializing"
            write_json(directory / "devbox.json", record)
            result = devbox.create(self.ws, args, "retry")
            self.assertEqual(result["state"], "prepared")
            self.assertEqual((directory / "disk.qcow2").read_bytes(), b"installed Windows disk")
            self.assertEqual((directory / "secrets/password").read_bytes(), password)
            self.assertEqual(devbox.load(self.ws, "resume")[1]["identity"], record["identity"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
