"""Acceptance against real local Git transports, never organization pushes."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time
import unittest

from wb.common import Failure, edit_pins, parse_pins
from wb import builds


ROOT = Path(os.environ["WB_TEST_SOURCE"])
WB = os.environ["WB_TEST_COMMAND"]
WRAPPER = os.environ["WB_TEST_GIT"]
REAL = os.environ["WB_REAL_GIT"]
MANIFEST = json.loads(Path(os.environ["WB_MANIFEST_FILE"]).read_text())


def call(argv, cwd=None, env=None, check=True):
    result = subprocess.run([str(v) for v in argv], cwd=cwd, env=env, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(str(argv) + "\n" + result.stdout + result.stderr)
    return result


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wb acceptance spaces ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "workspace with spaces"
        self.root.mkdir()
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
                    "GIT_AUTHOR_NAME": "Acceptance", "GIT_AUTHOR_EMAIL": "acceptance@example.invalid",
                    "GIT_COMMITTER_NAME": "Acceptance", "GIT_COMMITTER_EMAIL": "acceptance@example.invalid",
                    "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "protocol.file.allow", "GIT_CONFIG_VALUE_0": "always",
                    "WB_WORKSPACE_ROOT": str(self.root)}
        self.urls, self.shas = {}, {}
        self.upstream = self.base / "upstream"
        self.upstream.mkdir()
        names = sorted(MANIFEST["repositories"], key=lambda n: MANIFEST["repositories"][n]["path"].count("/"), reverse=True)
        # All submodule objects are served by local bare repos. One unmanaged
        # dependency also tests that QEMU and LookingGlass stay uninitialized.
        third_work, self.third_url, third_sha = self.make_source("third-party")
        shader_work, shader_url, shader_sha = self.make_source("shader-container")
        (shader_work / ".gitmodules").write_text(f'[submodule "headers"]\n\tpath = submodules/spirv_headers\n\turl = {self.third_url}\n')
        self.g(shader_work, "update-index", "--add", "--cacheinfo", "160000", third_sha, "submodules/spirv_headers")
        self.g(shader_work, "add", ".gitmodules")
        self.g(shader_work, "commit", "-m", "nested shader headers")
        shader_sha = self.g(shader_work, "rev-parse", "HEAD").stdout.strip()
        self.g(shader_work, "push", shader_url, "HEAD:dev")
        for name in names:
            repo = MANIFEST["repositories"][name]
            work = self.base / ("source " + name)
            work.mkdir()
            self.g(work, "init", "-b", "dev")
            (work / "source.txt").write_text(name + "\n")
            (work / "other.txt").write_text("original\n")
            children = {r["submodulePath"]: child for child, r in MANIFEST["repositories"].items() if r["parent"] == name}
            paths = list(repo["submodules"]["paths"])
            if name == "qemu-helios":
                paths += ["forbidden-qemu-module"]
            if name == "helios":
                paths += ["LookingGlass"]
            modules = ""
            for index, path in enumerate(paths):
                child = children.get(path)
                url, sha = (self.urls[child], self.shas[child]) if child else (self.third_url, third_sha)
                if name == "dxvk" and path == "subprojects/dxbc-spirv":
                    url, sha = shader_url, shader_sha
                modules += f'[submodule "m{index}"]\n\tpath = {path}\n\turl = {url}\n'
                self.g(work, "update-index", "--add", "--cacheinfo", "160000", sha, path)
            if modules:
                (work / ".gitmodules").write_text(modules)
                self.g(work, "add", ".gitmodules")
            self.g(work, "add", "source.txt", "other.txt")
            self.g(work, "commit", "-m", "fixture " + name)
            self.shas[name] = self.g(work, "rev-parse", "HEAD").stdout.strip()
            url = str(self.upstream / (name + ".git"))
            call([REAL, "clone", "--bare", work, url], env=self.env)
            self.urls[name] = url
        for relative in ["config/defaults.json", ".gitignore", "devenv.lock"]:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        (self.root / "devenv.nix").write_text("{ ... }: {}\n")
        (self.root / "nix").mkdir()
        (self.root / "nix/repositories.nix").write_text("{}\n")
        self.pins = self.root / "nix/pins.nix"
        self.pins.write_text(edit_pins((ROOT / "nix/pins.nix").read_text(),
            {n: {"rev": sha, "ref": "refs/heads/dev"} for n, sha in self.shas.items()}))
        self.local = {"schemaVersion": 1, "workspace": {"remotes": dict(self.urls)}}
        self.write_local()
        (self.root / "unrelated.txt").write_text("original\n")
        self.g(self.root, "init", "-b", "workspace")
        self.g(self.root, "add", "config/defaults.json", ".gitignore", "devenv.lock", "devenv.nix", "nix/pins.nix", "nix/repositories.nix", "unrelated.txt")
        self.g(self.root, "commit", "-m", "workspace fixture")

    def make_source(self, name):
        work = self.base / ("source " + name)
        work.mkdir()
        self.g(work, "init", "-b", "dev")
        (work / "file.txt").write_text(name)
        self.g(work, "add", "file.txt")
        self.g(work, "commit", "-m", name)
        sha = self.g(work, "rev-parse", "HEAD").stdout.strip()
        url = str(self.upstream / (name + ".git"))
        call([REAL, "clone", "--bare", work, url], env=self.env)
        return work, url, sha

    def write_local(self):
        (self.root / "local.json").write_text(json.dumps(self.local))

    def g(self, path, *args, check=True):
        return call([REAL, "-C", path, *args], env=self.env, check=check)

    def wb(self, *args, check=True, extra=None):
        result = call([WB, "--workspace", self.root, "--json", *args], env={**self.env, **(extra or {})}, check=check)
        data = json.loads(result.stdout)
        return data if not check else data["result"]

    def path(self, name):
        return self.root / MANIFEST["repositories"][name]["path"]

    def snapshot(self, path):
        return (self.g(path, "status", "--porcelain=v1").stdout,
                self.g(path, "diff", "--binary").stdout,
                self.g(path, "diff", "--cached", "--binary").stdout,
                self.g(path, "ls-files", "--stage").stdout)

    def develop(self, name="winboat"):
        self.wb("repo", "sync", "--repo", name)
        path = self.path(name)
        self.g(path, "switch", "-c", "dev")
        (path / "source.txt").write_text("changed\n")
        self.g(path, "add", "source.txt")
        self.g(path, "commit", "-m", "development")
        return path, self.g(path, "rev-parse", "HEAD").stdout.strip()

    def wrapper(self, *args, check=True, extra=None, cwd=None):
        return call([WRAPPER, *args], cwd=cwd or self.root, env={**self.env, **(extra or {})}, check=check)

    def test_selection_and_read_only_plan(self):
        before = self.snapshot(self.root)
        for subset, count in [("helios", 8), ("winboat", 3), ("winboat-accel", 12), ("all", 12)]:
            self.assertEqual(len(self.wb("repo", "list", "--subset", subset)["selected"]), count)
        selected = self.wb("repo", "plan", "--repo", "qemu-helios")
        self.assertEqual(set(selected["selected"]), {"qemu-helios", "virglrenderer", "venus-protocol"})
        self.assertEqual(selected["containers"], ["helios"])
        self.assertEqual(self.wb("repo", "list", "--repo", "clkvk-helios")["selected"], ["clvk-helios"])
        self.assertEqual(len(self.wb("repo", "list", "--repo", "winboat", "--repo", "electron")["selected"]), 2)
        self.assertEqual(before, self.snapshot(self.root))
        self.assertFalse((self.root / "repos").exists())
        self.assertEqual(self.wb("repo", "list", "--repo", "missing", check=False)["exitCode"], 2)

    def test_selective_nested_sync_and_all(self):
        self.wb("repo", "sync", "--repo", "qemu-helios")
        self.assertTrue((self.path("qemu-helios") / ".git").is_file())
        self.assertFalse((self.path("dxvk") / ".git").exists())
        self.assertFalse((self.path("qemu-helios") / "forbidden-qemu-module/.git").exists())
        self.assertFalse((self.path("helios") / "LookingGlass/.git").exists())
        self.wb("repo", "sync", "--subset", "all")
        for name in self.shas:
            self.assertEqual(self.g(self.path(name), "rev-parse", "HEAD").stdout.strip(), self.shas[name])
        self.assertTrue((self.path("dxil-spirv") / ".git").exists())
        self.assertTrue((self.path("venus-protocol") / ".git").exists())
        self.assertFalse((self.path("qemu-helios") / "forbidden-qemu-module/.git").exists())
        self.assertTrue((self.path("dxvk") / "include/native/directx/.git").exists())

    def test_dirty_staged_untracked_and_unselected_preserved(self):
        self.wb("repo", "sync", "--subset", "winboat")
        path = self.path("winboat")
        (path / "source.txt").write_text("staged\n")
        self.g(path, "add", "source.txt")
        (path / "source.txt").write_text("working\n")
        (path / "untracked.txt").write_text("keep\n")
        before = self.snapshot(path)
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in path.iterdir() if p.is_file()}
        self.assertNotEqual(self.wb("repo", "sync", "--subset", "winboat", check=False)["exitCode"], 0)
        self.assertEqual(self.snapshot(path), before)
        self.assertEqual(hashes, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in path.iterdir() if p.is_file()})
        self.wb("repo", "sync", "--repo", "electron")
        self.assertEqual(self.snapshot(path), before)

    def test_conflict_and_parent_consistency_refusal(self):
        path, _ = self.develop()
        self.g(path, "checkout", "-b", "conflict", self.shas["winboat"])
        (path / "source.txt").write_text("conflict\n")
        self.g(path, "add", "source.txt")
        self.g(path, "commit", "-m", "conflicting")
        self.g(path, "merge", "dev", check=False)
        before = self.snapshot(path)
        self.assertNotEqual(self.wb("repo", "sync", "--repo", "winboat", check=False)["exitCode"], 0)
        self.assertEqual(before, self.snapshot(path))
        self.pins.write_text(edit_pins(self.pins.read_text(), {"qemu-helios": {"rev": self.shas["winboat"]}}))
        # Use an available but inconsistent object from a local mirror.
        self.local["workspace"]["remotes"]["qemu-helios"] = self.urls["winboat"]
        self.write_local()
        self.assertIn("gitlink", self.wb("repo", "sync", "--repo", "qemu-helios", check=False)["error"])
        self.assertFalse((self.path("helios") / ".git").exists())

    def test_successful_push_preserves_root_work_and_index(self):
        path, sha = self.develop()
        (self.root / "unrelated.txt").write_text("staged unrelated\n")
        self.g(self.root, "add", "unrelated.txt")
        (self.root / "unrelated.txt").write_text("working unrelated\n")
        # Include an unrelated staged pin edit in the very same file.
        self.pins.write_text(edit_pins(self.pins.read_text(), {"electron": {"provenance": "unrelated-staged"}}))
        self.g(self.root, "add", "nix/pins.nix")
        self.pins.write_text(edit_pins(self.pins.read_text(), {"WBFreeRDP": {"provenance": "unrelated-working"}}))
        staged = self.g(self.root, "show", ":unrelated.txt").stdout
        self.wrapper("-C", str(path), "push", "origin", "dev:refs/heads/dev")
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["winboat"]["rev"], sha)
        headpins = parse_pins(self.g(self.root, "show", "HEAD:nix/pins.nix").stdout)["repositories"]
        self.assertNotEqual(headpins["electron"]["provenance"], "unrelated-staged")
        self.assertEqual(parse_pins(self.g(self.root, "show", ":nix/pins.nix").stdout)["repositories"]["electron"]["provenance"], "unrelated-staged")
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["WBFreeRDP"]["provenance"], "unrelated-working")
        self.assertEqual(self.g(self.root, "show", ":unrelated.txt").stdout, staged)
        self.assertEqual((self.root / "unrelated.txt").read_text(), "working unrelated\n")
        self.assertEqual(self.g(self.root, "show", "HEAD:unrelated.txt").stdout, "original\n")

    def test_push_exact_source_not_checkout_head_and_noop(self):
        path, sha = self.develop()
        (path / "source.txt").write_text("newer HEAD\n")
        self.g(path, "add", "source.txt")
        self.g(path, "commit", "-m", "newer")
        self.wrapper("-C", path, "-c", "push.default=current", "push", "origin", sha + ":refs/heads/dev")
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["winboat"]["rev"], sha)
        self.assertNotEqual(self.g(path, "rev-parse", "HEAD").stdout.strip(), sha)
        before = self.g(self.root, "rev-parse", "HEAD").stdout
        self.wrapper("-C", path, "push", "origin", sha + ":refs/heads/dev")
        self.assertEqual(self.g(self.root, "rev-parse", "HEAD").stdout, before)

    def test_failed_dryrun_tag_delete_unselected_and_ambiguous(self):
        path, sha = self.develop()
        original = self.pins.read_bytes()
        self.wrapper("-C", path, "push", "--dry-run", "origin", "dev:dev")
        self.assertEqual(self.pins.read_bytes(), original)
        self.wrapper("-C", path, "push", "origin", "dev:other")
        self.g(path, "tag", "test")
        self.wrapper("-C", path, "push", "origin", "refs/tags/test")
        self.wrapper("-C", path, "push", "origin", ":other")
        self.assertEqual(self.pins.read_bytes(), original)
        self.assertNotEqual(self.wrapper("-C", path, "push", "--all", "origin", check=False).returncode, 0)
        hook = Path(self.urls["winboat"]) / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        self.assertNotEqual(self.wrapper("-C", path, "push", "origin", "dev:dev", check=False).returncode, 0)
        self.assertEqual(self.pins.read_bytes(), original)

    def test_wrapper_multiple_refspecs_detached_lease_and_global_options(self):
        path, sha = self.develop()
        self.g(path, "checkout", "--detach", sha)
        self.wrapper("--git-dir=" + str(path / ".git"), "--work-tree=" + str(path), "push", "--force-with-lease=refs/heads/dev:" + self.shas["winboat"], "origin", "HEAD:refs/heads/dev", "HEAD:refs/heads/topic")
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["winboat"]["rev"], sha)
        self.assertEqual(self.wrapper("-C", path, "rev-parse", "HEAD").stdout.strip(), sha)
        self.wrapper("-C", path.parent, "-C", path.name, "status", "--short")

    def test_alternate_pushurl_and_mirror_are_rejected_before_effect(self):
        path, sha = self.develop()
        alternate = self.base / "alternate.git"
        call([REAL, "clone", "--bare", self.urls["winboat"], alternate], env=self.env)
        self.g(path, "remote", "set-url", "--push", "origin", str(alternate))
        self.assertNotEqual(self.wrapper("-C", path, "push", "origin", "dev:dev", check=False).returncode, 0)
        self.assertEqual(self.g(alternate, "rev-parse", "dev").stdout.strip(), self.shas["winboat"])
        self.assertNotEqual(self.wrapper("-C", path, "push", "--mirror", "origin", check=False).returncode, 0)

    def test_post_push_write_and_commit_failure_reconciliation(self):
        path, sha = self.develop()
        result = self.wrapper("-C", path, "push", "origin", "dev:dev", check=False, extra={"WB_TEST_FAIL_PIN_WRITE": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.g(Path(self.urls["winboat"]), "rev-parse", "dev").stdout.strip(), sha)
        receipts = list((self.root / ".state/operations").glob("*.json"))
        receipt = next(json.loads(p.read_text()) for p in receipts if json.loads(p.read_text()).get("kind") == "push")
        self.assertEqual(receipt["state"], "partial")
        self.assertEqual(self.wb("repo", "reconcile", "--operation", receipt["operationId"])["state"], "succeeded")
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["winboat"]["rev"], sha)
        (path / "source.txt").write_text("commit failure\n")
        self.g(path, "add", "source.txt")
        self.g(path, "commit", "-m", "commit failure")
        self.assertNotEqual(self.wrapper("-C", path, "push", "origin", "dev:dev", check=False,
                                       extra={"WB_TEST_FAIL_PIN_COMMIT": "1"}).returncode, 0)
        receipts = [json.loads(p.read_text()) for p in (self.root / ".state/operations").glob("*.json")]
        pending = next(r for r in receipts if r.get("kind") == "push" and r["state"] == "partial")
        self.wb("repo", "reconcile", "--operation", pending["operationId"])

    def test_concurrent_disjoint_pin_writers(self):
        paths = [self.develop("winboat"), self.develop("electron")]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda pair: self.wrapper("-C", pair[0], "push", "origin", "dev:dev"), paths))
        pins = parse_pins(self.pins.read_text())["repositories"]
        self.assertEqual(pins["winboat"]["rev"], paths[0][1])
        self.assertEqual(pins["electron"]["rev"], paths[1][1])

    def test_deferred_checkpoint_and_remote_drift_refusal(self):
        path, sha = self.develop()
        oldhead = self.g(self.root, "rev-parse", "HEAD").stdout
        transaction = self.wb("repo", "push", "--repo", "winboat", "--defer-checkpoint")["transactions"][0]
        self.assertEqual(transaction["state"], "deferred")
        self.assertEqual(self.g(self.root, "rev-parse", "HEAD").stdout, oldhead)
        self.wb("repo", "reconcile", "--operation", transaction["operationId"])
        self.assertEqual(parse_pins(self.g(self.root, "show", "HEAD:nix/pins.nix").stdout)["repositories"]["winboat"]["rev"], sha)
        (path / "source.txt").write_text("after receipt\n")
        self.g(path, "add", "source.txt")
        self.g(path, "commit", "-m", "after receipt")
        self.g(path, "push", "origin", "dev:dev")
        oldpin = self.pins.read_bytes()
        self.assertNotEqual(self.wb("repo", "reconcile", "--operation", transaction["operationId"], check=False)["exitCode"], 0)
        self.assertEqual(self.pins.read_bytes(), oldpin)

    def test_explicit_pin_source_and_single_alternate_pushurl(self):
        path, sha = self.develop()
        alternate = self.base / "explicit alternate.git"
        call([REAL, "clone", "--bare", self.urls["winboat"], alternate], env=self.env)
        self.wb("repo", "pin", "--repo", "winboat", "--rev", self.shas["winboat"], "--ref", "refs/heads/dev", "--source-url", str(alternate))
        self.g(path, "remote", "set-url", "--push", "origin", str(alternate))
        self.wrapper("-C", path, "push", "origin", "dev:dev")
        pin = parse_pins(self.pins.read_text())["repositories"]["winboat"]
        self.assertEqual(pin["rev"], sha)
        self.assertEqual(pin["sourceUrl"], str(alternate))

    def test_subset_works_with_unresolved_unselected_pin_and_path_precedence(self):
        self.pins.write_text(edit_pins(self.pins.read_text(), {"electron": {"rev": None}}))
        self.wb("repo", "sync", "--subset", "helios")
        self.assertEqual(self.wb("repo", "sync", "--repo", "electron", check=False)["state"], "failed")
        result = self.wb("--repositories-root", "sources with spaces", "repo", "list", "--repo", "winboat")
        self.assertEqual(result["repositories"][0]["path"], str(self.root / "sources with spaces/winboat"))
        self.assertEqual(self.wb("--state-root", ".", "repo", "list", check=False)["state"], "failed")

    def test_branch_creation_and_checkpoint_deletion_scope(self):
        self.wb("repo", "sync", "--repo", "winboat")
        result = self.wb("repo", "branch", "--repo", "winboat")
        self.assertEqual(result["branch"], "dev")
        path = self.path("winboat")
        (path / "other.txt").unlink()
        self.wb("repo", "checkpoint", "--repo", "winboat", "--path", "winboat:other.txt", "--message", "explicit deletion")
        self.assertNotEqual(self.g(path, "show", "HEAD:other.txt", check=False).returncode, 0)

    def test_managed_delete_and_push_outside_workspace(self):
        path, sha = self.develop()
        self.g(Path(self.urls["winboat"]), "config", "receive.denyDeleteCurrent", "ignore")
        before = self.pins.read_bytes()
        self.wrapper("-C", path, "push", "origin", ":refs/heads/dev")
        self.assertEqual(before, self.pins.read_bytes())
        external, remote, revision = self.make_source("unmanaged")
        self.g(external, "remote", "add", "origin", remote)
        (external / "file.txt").write_text("unmanaged edit")
        self.g(external, "add", "file.txt")
        self.g(external, "commit", "-m", "unmanaged edit")
        self.wrapper("-C", external, "push", "origin", "dev:dev")
        self.assertEqual(before, self.pins.read_bytes())

    def test_durable_push_cancellation_refuses_blind_resume(self):
        path, sha = self.develop()
        hook = Path(self.urls["winboat"]) / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\nsleep 3\nexit 0\n")
        hook.chmod(0o755)
        job = self.wb("repo", "push", "--repo", "winboat", "--background")
        for _ in range(100):
            receipt = self.wb("job", "status", "--id", job["jobId"])
            if receipt["state"] == "running" and "workerPid" in receipt:
                break
            time.sleep(0.02)
        self.assertEqual(receipt["state"], "running")
        self.wb("job", "cancel", "--id", job["jobId"])
        for _ in range(100):
            receipt = self.wb("job", "status", "--id", job["jobId"], check=False)["result"]
            if receipt["state"] == "cancelled":
                break
            time.sleep(0.02)
        self.assertEqual(receipt["state"], "cancelled")
        self.assertNotEqual(self.wb("job", "resume", "--id", job["jobId"], check=False)["exitCode"], 0)
        self.assertEqual(self.g(Path(self.urls["winboat"]), "rev-parse", "dev").stdout.strip(), self.shas["winboat"])

    def test_checkpoint_scope_and_parent_publication(self):
        self.wb("repo", "sync", "--repo", "venus-protocol")
        path = self.path("venus-protocol")
        (path / "source.txt").write_text("checkpoint\n")
        (path / "other.txt").write_text("staged unrelated\n")
        self.g(path, "add", "other.txt")
        self.wb("repo", "checkpoint", "--repo", "venus-protocol", "--path", "source.txt", "--message", "scoped checkpoint")
        self.assertEqual(self.g(path, "show", "HEAD:other.txt").stdout, "original\n")
        self.assertEqual(self.g(path, "show", ":other.txt").stdout, "staged unrelated\n")
        sha = self.g(path, "rev-parse", "HEAD").stdout.strip()
        self.wrapper("-C", path, "push", "origin", "HEAD:dev")
        parent = self.path("helios")
        self.assertEqual(self.g(parent, "ls-tree", "HEAD", "venus-protocol").stdout.split()[2], sha)
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["helios"]["rev"], self.shas["helios"])
        self.wrapper("-C", parent, "push", "origin", "HEAD:dev")
        self.assertEqual(parse_pins(self.pins.read_text())["repositories"]["helios"]["rev"], self.g(parent, "rev-parse", "HEAD").stdout.strip())

    def test_fork_scoped_remotes_and_missing_fork(self):
        self.wb("repo", "sync", "--subset", "winboat")
        before = self.pins.read_bytes()
        fork = self.base / "forks/contributor"
        fork.mkdir(parents=True)
        for name in ["winboat", "electron", "WBFreeRDP"]:
            call([REAL, "clone", "--bare", self.urls[name], fork / (name + ".git")], env=self.env)
            self.local["workspace"]["remotes"][name] = str(self.base / ("forks/{namespace}/" + name + ".git"))
        # Canonical upstream remotes are retained for validation after a fork.
        for name in ["winboat", "electron", "WBFreeRDP"]:
            self.g(self.path(name), "remote", "add", "upstream", MANIFEST["repositories"][name]["url"])
        self.write_local()
        self.wb("repo", "fork", "--repo", "winboat", "--namespace", "contributor", "--apply")
        self.assertEqual(self.g(self.path("winboat"), "remote", "get-url", "origin").stdout.strip(), str(fork / "winboat.git"))
        self.assertEqual(self.g(self.path("electron"), "remote", "get-url", "origin").stdout.strip(), self.urls["electron"])
        self.assertEqual(self.pins.read_bytes(), before)
        self.assertIn("fork unavailable", self.wb("repo", "fork", "--repo", "electron", "--namespace", "missing", "--apply", check=False)["error"])

    def test_configuration_setup_and_read_only_adoption(self):
        self.wb("setup")
        config = (self.root / "local.json").read_bytes()
        self.wb("setup")
        self.assertEqual(config, (self.root / "local.json").read_bytes())
        self.wb("repo", "sync", "--repo", "winboat")
        external = self.base / "read only reference"
        shutil.move(self.path("winboat"), external)
        (external / "untracked.txt").write_text("preserve")
        self.local["workspace"]["repositoryOverrides"] = {"winboat": {"path": str(external), "adopt": True, "readOnly": True}}
        self.write_local()
        before = self.snapshot(external)
        self.assertTrue(self.wb("repo", "status", "--repo", "winboat")["repositories"][0]["present"])
        self.assertIn("read-only", self.wb("repo", "sync", "--repo", "winboat", check=False)["error"])
        self.assertEqual(before, self.snapshot(external))

    def test_mcp_cli_parity_typed_failures_and_durable_disconnect(self):
        process = subprocess.Popen([WB, "--workspace", str(self.root), "mcp"], env=self.env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait()
            for handle in [process.stdin, process.stdout, process.stderr]:
                handle.close()
        self.addCleanup(cleanup)
        request_id = 0
        def rpc(method, params=None):
            nonlocal request_id
            request_id += 1
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}) + "\n")
            process.stdin.flush()
            self.assertTrue(select.select([process.stdout], [], [], 30)[0], "MCP response timed out")
            return json.loads(process.stdout.readline())
        self.assertIn("serverInfo", rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "acceptance", "version": "1"}})["result"])
        tools = rpc("tools/list")["result"]["tools"]
        self.assertIn("repo_reconcile", [t["name"] for t in tools])
        self.assertIn("build_run", [t["name"] for t in tools])
        build_list = rpc("tools/call", {"name": "build_list", "arguments": {}})["result"]
        self.assertEqual(build_list["structuredContent"]["result"], self.wb("build", "list"))
        build_plan = rpc("tools/call", {"name": "build_run", "arguments": {"target": "dxvk-engine-x64", "plan": True}})["result"]
        self.assertEqual(build_plan["structuredContent"]["result"], self.wb("build", "dxvk-engine-x64", "--plan"))
        unavailable = rpc("tools/call", {"name": "build_run", "arguments": {"target": "dxvk-engine-x64", "background": False}})["result"]
        self.assertTrue(unavailable["isError"])
        self.assertEqual(unavailable["structuredContent"]["details"]["backend"], "devbox")
        response = rpc("tools/call", {"name": "repo_status", "arguments": {"repos": ["winboat"]}})["result"]
        self.assertEqual(response["structuredContent"]["result"], self.wb("repo", "status", "--repo", "winboat"))
        bad = rpc("tools/call", {"name": "repo_sync", "arguments": {"repos": "winboat"}})
        self.assertEqual(bad["error"]["code"], -32602)
        failed = rpc("tools/call", {"name": "repo_status", "arguments": {"repos": ["missing"]}})["result"]
        self.assertTrue(failed["isError"])
        sync = rpc("tools/call", {"name": "repo_sync", "arguments": {"repos": ["winboat"], "background": False}})["result"]
        self.assertFalse(sync["isError"])
        path = self.path("winboat")
        (path / "source.txt").write_text("MCP checkpoint\n")
        checkpoint = rpc("tools/call", {"name": "repo_checkpoint", "arguments": {"repos": ["winboat"], "paths": ["source.txt"], "message": "MCP checkpoint"}})["result"]
        self.assertFalse(checkpoint["isError"])
        bad_fork = rpc("tools/call", {"name": "repo_fork", "arguments": {"repos": ["winboat"], "namespace": "invalid namespace"}})["result"]
        self.assertTrue(bad_fork["isError"])
        fork = self.base / "mcp-fork/contributor"
        fork.mkdir(parents=True)
        call([REAL, "clone", "--bare", self.urls["winboat"], fork / "winboat.git"], env=self.env)
        self.g(path, "remote", "add", "upstream", MANIFEST["repositories"]["winboat"]["url"])
        self.local["workspace"]["remotes"]["winboat"] = str(self.base / "mcp-fork/{namespace}/winboat.git")
        self.write_local()
        applied_fork = rpc("tools/call", {"name": "repo_fork", "arguments": {"repos": ["winboat"], "namespace": "contributor", "apply": True}})["result"]
        self.assertFalse(applied_fork["isError"])
        self.assertEqual(self.g(path, "remote", "get-url", "origin").stdout.strip(), str(fork / "winboat.git"))
        job = rpc("tools/call", {"name": "repo_sync", "arguments": {"repos": ["electron"]}})["result"]["structuredContent"]["result"]
        process.terminate()
        process.wait(timeout=5)
        for _ in range(100):
            receipt = self.wb("job", "status", "--id", job["jobId"])
            if receipt["state"] in {"succeeded", "failed", "interrupted"}:
                break
            time.sleep(0.05)
        self.assertEqual(receipt["state"], "succeeded")
        self.assertTrue(self.path("electron").exists())

    def test_build_plan_is_selective_and_unavailable_backend_fails_closed(self):
        before = self.snapshot(self.root)
        result = self.wb("build", "venus-protocol", "--plan")
        self.assertEqual([r["repository"] for r in result["sources"]], ["venus-protocol"])
        self.assertFalse(self.path("electron").exists())
        self.assertEqual(before, self.snapshot(self.root))
        refused = self.wb("build", "helios-guest-x64", check=False)
        self.assertEqual(refused["exitCode"], 3)
        self.assertIn("Stage 4", refused["error"])

    def test_source_snapshot_preserves_work_and_detects_dirty_and_missing_gitlinks(self):
        self.wb("repo", "sync", "--repo", "winboat")
        path = self.path("winboat")
        before = self.snapshot(path)
        exported = self.base / "export clean"
        record = builds._export(path, exported, "release", self.shas["winboat"])
        self.assertEqual(record["revision"], self.shas["winboat"])
        self.assertEqual((exported / "source.txt").read_bytes(), (path / "source.txt").read_bytes())
        self.assertEqual(before, self.snapshot(path))
        (path / "source.txt").write_text("dirty snapshot")
        (path / "new file").write_text("new")
        with self.assertRaises(Failure):
            builds._export(path, self.base / "refused", "release", self.shas["winboat"])
        before = self.snapshot(path)
        dirty = builds._export(path, self.base / "development", "development", self.shas["winboat"])
        self.assertIsNotNone(dirty["diffSha256"])
        self.assertNotEqual(record["snapshotSha256"], dirty["snapshotSha256"])
        self.assertEqual(before, self.snapshot(path))
        (path / "escape").symlink_to("/etc/passwd")
        with self.assertRaises(Failure):
            builds._export(path, self.base / "unsafe", "development")

    def test_release_snapshot_respects_git_checkout_filters(self):
        path, _, _ = self.make_source("filtered-checkout")
        (path / ".gitattributes").write_text("*.csv text eol=crlf\n")
        (path / "data.csv").write_bytes(b"name,value\r\nsource,clean\r\n")
        self.g(path, "add", ".gitattributes", "data.csv")
        self.g(path, "commit", "-m", "declare CSV checkout normalization")
        head = self.g(path, "rev-parse", "HEAD").stdout.strip()
        self.assertEqual(self.g(path, "status", "--porcelain").stdout, "")
        exported = self.base / "filtered-export"
        record = builds._export(path, exported, "release", head)
        self.assertEqual(record["revision"], head)
        self.assertIsNone(record["diffSha256"])
        self.assertEqual((exported / "data.csv").read_bytes(), (path / "data.csv").read_bytes())

    def test_artifact_verification_rejects_tampering_and_extra_files(self):
        artifact = self.base / "artifact"
        files = artifact / "files"
        files.mkdir(parents=True)
        (files / "binary").write_bytes(b"built image")
        (files / "source-overlay").symlink_to(".", target_is_directory=True)
        manifest = artifact / "manifest.json"
        manifest.write_text(json.dumps({"schemaVersion": 1, "state": "built", "artifactId": "test",
                                        "files": builds._files(files)}))
        self.assertEqual(builds.verify(manifest)["filesVerified"], 2)
        (files / "binary").write_bytes(b"different image")
        with self.assertRaises(Failure):
            builds.verify(manifest)
        (files / "source-overlay").unlink()
        (files / "source-overlay").symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(Failure):
            builds.verify(manifest)
        (files / "binary").write_bytes(b"built image")
        (files / "unexpected").write_bytes(b"extra")
        (files / "source-overlay").unlink()
        (files / "source-overlay").symlink_to(".", target_is_directory=True)
        with self.assertRaises(Failure):
            builds.verify(manifest)


if __name__ == "__main__":
    unittest.main(verbosity=2)
