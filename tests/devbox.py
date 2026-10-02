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

from wb import devbox
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

    def test_relocated_state_keeps_ownership_and_defined_guest_defaults(self):
        record = self.record()
        moved = self.root.parent / "relocated workspace with spaces"
        shutil.move(self.root, moved)
        self.ws.root = moved; self.ws.state = moved / ".state"
        self.assertEqual(devbox.load(self.ws, "one")[1]["identity"], record["identity"])
        self.ws.config["devbox"] = {"guestUsername": "different-host-user"}
        with self.assertRaises(Failure):
            devbox.settings(self.ws)

    def test_interrupted_creation_preserves_keys_and_existing_disk(self):
        media = {"sha256": "d" * 64, "image": {"index": 1}, "locale": "en-US"}
        artifact = {"manifestSha256": "e" * 64, "output": str(self.root / "stack")}
        payloads = self.root / "payloads"; payloads.mkdir()
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
