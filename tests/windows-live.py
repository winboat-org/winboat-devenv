"""Opt-in acceptance on an explicitly named, already running development guest.

Run with wb-windows-live --name NAME --state-root PATH. This owns only unique
task/fixture paths; it neither creates nor destroys a VM. Receipts are retained.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
import sys


class Acceptance:
    def __init__(self, args):
        self.args = args
        self.root = Path(os.environ["WB_WORKSPACE_ROOT"])
        self.command = os.environ["WB_LIVE_COMMAND"]
        self.prefix = [self.command, "--workspace", str(self.root), "--state-root", args.state_root, "--json"]
        self.directory = Path(args.state_root) / "windows-acceptance" / uuid.uuid4().hex
        self.directory.mkdir(parents=True)
        self.results = []
        self.counter = 0
        self.mcp = None
        self.stack_results = []

    def record(self, label, result):
        self.results.append({"label": label, "observed": time.time(), "receipt": result})
        (self.directory / "receipts.json").write_text(json.dumps(self.results, indent=2) + "\n")
        return result

    def cli(self, label, *args):
        proc = subprocess.run(self.prefix + list(args), capture_output=True, text=True, timeout=900)
        result = json.loads(proc.stdout)
        return self.record(label, result)

    def tool(self, name, arguments):
        if self.mcp is None:
            self.mcp = subprocess.Popen(self.prefix[:-1] + ["mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "windows-acceptance", "version": "1"}})
        response = self.rpc("tools/call", {"name": name, "arguments": arguments})
        if "error" in response:
            raise AssertionError(response)
        return self.record(name, response["result"]["structuredContent"])

    def rpc(self, method, params):
        self.counter += 1
        self.mcp.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.counter, "method": method, "params": params}) + "\n")
        self.mcp.stdin.flush()
        response = json.loads(self.mcp.stdout.readline())
        assert response["id"] == self.counter, response
        return response

    def wait(self, identifier, expected=0, via_mcp=False):
        deadline = time.monotonic() + max(180, self.args.seconds + 120)
        while time.monotonic() < deadline:
            if via_mcp:
                response = self.tool("devbox_job_status", {"name": self.args.name, "id": identifier})
            else:
                response = self.cli("guest-status", "devbox", "job", "status", "--name", self.args.name, "--id", identifier)
            value = response["result"]
            if value["state"] not in {"queued", "running"}:
                assert value["exitCode"] == expected, response
                return value
            time.sleep(5)
        raise AssertionError("Guest task did not reach a terminal receipt")

    def host_operation(self, submitted, via_mcp=False, allowed=(0,)):
        """Retain detached-worker completion, including full native reboot codes."""
        assert submitted['exitCode'] == 0, submitted
        identifier = submitted['result']['jobId']
        while True:
            response = (self.tool('job_status', {'id': identifier}) if via_mcp else
                        self.cli('host-job-status', 'job', 'status', '--id', identifier))
            job = response.get('result')
            assert job and job.get('jobId') == identifier, response
            if job['state'] not in {'queued', 'running'}:
                assert job['state'] in {'succeeded', 'failed'}, job
                operation = job.get('operation')
                # Host process exit codes truncate 3010. The operation receipt
                # preserves the real native code and original transaction ID.
                assert operation and operation['exitCode'] in allowed, job
                return operation
            assert response['exitCode'] == 0, response
            time.sleep(20)

    def full_stack(self):
        previous_sources = None
        for via_mcp in (False, True):
            surface = 'mcp' if via_mcp else 'cli'
            def execute(label, tool, arguments, *cli_args, allowed=(0,)):
                started = (self.tool(tool, {**arguments, 'background': True}) if via_mcp else
                           self.cli(surface + '-' + label, *cli_args, '--background'))
                return self.host_operation(started, via_mcp, allowed)

            # Each surface builds the full stack through the same Nix recipes.
            # No development snapshots or implicit candidate reuse are accepted.
            built = execute('stack-build', 'devbox_build',
                {'name': self.args.name, 'target': 'helios-development-package', 'mode': 'release'},
                'devbox', 'build', '--name', self.args.name,
                '--target', 'helios-development-package', '--mode', 'release')
            artifact_path = Path(built['result']['manifest'])
            artifact = json.loads(artifact_path.read_text())
            assert artifact['mode'] == 'release', artifact
            def clean_sources(record):
                for source in record['sources'].values():
                    assert not source.get('diffSha256') and not source.get('untracked'), source
                for dependency in record.get('componentDependencies', []):
                    clean_sources(dependency)
            clean_sources(artifact)
            if via_mcp:
                verified = self.tool('build_verify', {'manifest': str(artifact_path)})
            else:
                verified = self.cli('cli-stack-export-verify', 'build', 'verify', '--manifest', str(artifact_path))
            assert verified['exitCode'] == 0, verified
            manifest_path = artifact_path.parent / 'files' / 'bundle' / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
            assert manifest['symbolStorage'] == 'component-artifacts', manifest['symbolStorage']
            assert not any(f['path'].lower().endswith('.pdb') for f in manifest['files'])
            compiler = next(d for d in artifact['componentDependencies'] if d['target'] == 'clvk-helios')
            policy_path = artifact_path.parent.parent / compiler['artifactId'] / 'files' / 'package' / 'llvm-symbol-policy.json'
            compiler_policy = json.loads(policy_path.read_text(encoding='utf-8-sig'))
            assert compiler_policy['debugSymbols'] is False and compiler_policy['pdbFiles'] == 0, compiler_policy
            assert compiler_policy['compilerCommandsChecked'] > 0, compiler_policy
            self.record(surface + '-symbol-policy', {'runtimeBundlePdbFiles': 0, 'compiler': compiler_policy,
                'componentManifestSha256': compiler['manifestSha256']})
            if previous_sources is not None:
                assert manifest['source'] == previous_sources, manifest['source']
            previous_sources = manifest['source']
            manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            installed = execute('stack-install', 'devbox_install',
                {'name': self.args.name, 'manifest': str(manifest_path)},
                'devbox', 'install', '--name', self.args.name, '--manifest', str(manifest_path),
                allowed=(0, 3010, 1641))
            transaction = installed['result']['operationId']
            for _ in range(3):
                if installed['exitCode'] == 0:
                    break
                boot = installed['result']['bootTime']
                execute('stack-restart', 'devbox_restart', {'name': self.args.name, 'timeout': 180},
                        'devbox', 'restart', '--name', self.args.name, '--timeout', '180')
                # Wait for authenticated SSH before resuming the original task.
                for _ in range(60):
                    status = (self.tool('devbox_job_status', {'name': self.args.name, 'id': transaction}) if via_mcp else
                              self.cli('stack-reconnect', 'devbox', 'job', 'status', '--name', self.args.name, '--id', transaction))
                    # A completed SSH observation preserves the original native
                    # reboot code until this same transaction is resumed.
                    if (status.get('exitCode') in {0, 3010, 1641}
                            and status.get('result', {}).get('operationId') == transaction):
                        break
                    time.sleep(5)
                else:
                    raise AssertionError('Full-stack guest reconnect failed after reboot')
                installed = execute('stack-resume', 'devbox_install', {'name': self.args.name, 'resume': transaction},
                    'devbox', 'install', '--name', self.args.name, '--resume', transaction, allowed=(0, 3010, 1641))
                assert installed['result']['bootTime'] != boot, installed
            assert installed['exitCode'] == 0, installed
            smoke = execute('stack-smoke', 'devbox_smoke', {'name': self.args.name, 'transaction': transaction},
                            'devbox', 'smoke', '--name', self.args.name, '--transaction', transaction)
            graphics = smoke['result']
            assert graphics['state'] == 'passed' and graphics['sessionId'] > 0, graphics
            assert graphics['manifestSha256'] == manifest_hash, graphics
            assert len(graphics['mappedImages']) == 12 and len(graphics['workloads']) == 13, graphics
            observed = execute('stack-registry', 'devbox_registry_verify', {'name': self.args.name},
                               'devbox', 'registry', 'verify', '--name', self.args.name)['result']
            assert observed['installedVerified'] and observed['loadedVerified'], observed
            assert observed['loadedKernelIdentity'] == 'mapped-code-matches', observed
            assert observed['packageProvenance']['manifestSha256'] == manifest_hash, observed
            self.stack_results.append({'surface': surface, 'artifactManifest': str(artifact_path),
                'manifestSha256': manifest_hash, 'transactionId': transaction,
                'registryOperationId': observed['operationId'], 'bootTime': observed['bootTime'],
                'componentBuildsReused': False, 'installedVerified': True, 'loadedVerified': True})
            self.record(surface + '-full-stack-passed', self.stack_results[-1])

    def run(self):
        if self.args.component_only:
            self.extras()
            self.finish()
            return
        fixture = str(self.root / "tests/WindowsControlFixture.ps1")
        value = "literal ' quotes \" & $dollar`n\nsecond line"
        started = self.cli("durable-start", "devbox", "run", "--name", self.args.name, "--purpose", "build", "--script", fixture,
                           "--argument=-Seconds", "--argument=" + str(self.args.seconds), "--argument=-Value", "--argument=" + value)
        assert started["exitCode"] == 0, started
        identifier = started["operationId"]
        # The starting CLI has exited. Subsequent work uses new connections.
        refused = self.cli("session-zero-refusal", "devbox", "run", "--name", self.args.name, "--purpose", "desktop", "--direct", "--script", fixture)
        assert refused["exitCode"] == 87 and refused["result"]["sessionId"] == 0, refused
        desktop = self.tool("devbox_run", {"name": self.args.name, "purpose": "desktop", "script": fixture,
                                          "arguments": ["-Seconds", "1", "-Value", value]})
        assert desktop["exitCode"] == 0, desktop
        observed = self.wait(desktop["operationId"], via_mcp=True)
        assert observed["sessionId"] > 0 and observed["principal"].endswith("\\wbdev"), observed
        for code in [42, 3010]:
            submitted = self.tool("devbox_run", {"name": self.args.name, "purpose": "system", "script": fixture,
                "arguments": ["-Seconds", "1", "-ExitCode", str(code), "-Value", value]})
            assert submitted["exitCode"] == 0, submitted
            observed = self.wait(submitted["operationId"], expected=code, via_mcp=True)
            assert observed["state"] == ("reboot-required" if code == 3010 else "failed"), observed
            assert json.loads(observed["logs"]["stdout.log"].splitlines()[-1])["argument"] == value, observed
        self.large_request_fixture()
        cancelled = self.cli("cancel-start", "devbox", "run", "--name", self.args.name, "--purpose", "build", "--script", fixture, "--argument=-Seconds", "--argument=15")
        assert cancelled["exitCode"] == 0, cancelled
        cancellation = self.tool("devbox_job_cancel", {"name": self.args.name, "id": cancelled["operationId"]})
        assert cancellation["exitCode"] == 130, cancellation
        resumed = self.tool("devbox_job_resume", {"name": self.args.name, "id": cancelled["operationId"]})
        assert resumed["exitCode"] == 0, resumed
        self.wait(cancelled["operationId"], via_mcp=True)
        tamper = self.directory / 'tamper-input.ps1'
        tamper.write_text("Add-Content -LiteralPath 'C:\\ProgramData\\WinBoatDev\\jobs\\" + cancelled['operationId'] + "\\payload.ps1' -Value '# modified input'\n")
        staged = self.tool('devbox_run', {'name':self.args.name,'purpose':'system','script':str(tamper)})
        assert staged['exitCode'] == 0, staged
        self.wait(staged['operationId'], via_mcp=True)
        rejected = self.tool('devbox_job_resume', {'name':self.args.name,'id':cancelled['operationId']})
        assert rejected['exitCode'] != 0 and 'Verified file changed' in rejected['error'], rejected
        self.install_fixture()
        final = self.wait(identifier)
        assert final["principal"] == "NT AUTHORITY\\SYSTEM" and final["sessionId"] == 0, final
        lines = final["logs"]["stdout.log"].splitlines()
        assert sum(line.startswith("tick=") for line in lines) == self.args.seconds, final
        output = json.loads(lines[-1])
        assert output["argument"] == value and output["cargoTarget"].startswith("C:\\WinBoatDev\\build\\"), output
        self.extras()
        self.finish()

    def extras(self):
        if self.args.large_request:
            self.large_request_fixture()
        if self.args.input_fixtures:
            self.input_fixtures()
        if self.args.native:
            self.native_fixture()
        for target in self.args.build_target:
            built = self.tool("devbox_build", {"name": self.args.name, "target": target, "background": False})
            assert built["exitCode"] == 0 and built["result"]["state"] == "succeeded", built
            verified = self.tool("build_verify", {"manifest": built["result"]["manifest"]})
            assert verified["exitCode"] == 0 and not verified["result"]["loaded"], verified
        if self.args.reboot:
            self.reboot_fixture()
        if self.args.full_stack:
            self.full_stack()

    def large_request_fixture(self):
        # Encoding the whole request twice previously exceeded CreateProcess's
        # command-line limit even though the retained JSON was valid.
        value = "literal ' quotes \" & $dollar`n\nsecond line " * 600
        submitted = self.tool('devbox_run', {'name': self.args.name, 'purpose': 'system',
            'script': str(self.root/'tests/WindowsControlFixture.ps1'),
            'arguments': ['-Seconds', '0', '-ExitCode', '42', '-Value', value]})
        assert submitted['exitCode'] == 0, submitted
        observed = self.wait(submitted['operationId'], expected=42, via_mcp=True)
        assert observed['sessionId'] == 0 and observed['principal'] == 'NT AUTHORITY\\SYSTEM', observed
        assert json.loads(observed['logs']['stdout.log'].splitlines()[-1])['argument'] == value
        request_path = Path(self.args.state_root)/'devboxes'/self.args.name/'windows-jobs'/submitted['operationId']/'request.json'
        request_bytes = request_path.stat().st_size
        assert request_bytes > 20000
        self.record('large-request-passed', {'operationId': submitted['operationId'],
            'requestBytes': request_bytes, 'argumentSha256': hashlib.sha256(value.encode()).hexdigest(),
            'exitCode': observed['exitCode'], 'principal': observed['principal'], 'sessionId': observed['sessionId']})

    def finish(self):
        summary = {"schemaVersion": 1, "state": "passed", "durationSeconds": self.args.seconds,
                   "eightMinuteDurability": not self.args.component_only and self.args.seconds >= 480, "receipts": str(self.directory / "receipts.json"),
                   "fullComponentAcceptance": len(self.stack_results) == 2,
                   "stackRepeats": self.stack_results}
        (self.directory / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary), flush=True)

    def input_fixtures(self):
        from wb import windows
        from wb.common import identity
        from wb.workspace import Workspace
        workspace = Workspace(self.root, {"stateRoot": self.args.state_root})
        for script, result_name, inputs in [
            ('WindowsTreeFixture.ps1', 'tree-fixture.json', {}),
            ('WindowsPriorInventoryFixture.ps1', 'prior-inventory-fixture.json', {}),
            ('WindowsSnapshotFixture.ps1', 'snapshot-fixture-result.json',
             {'Snapshot.ps1': Path(os.environ['WB_DEVBOX_PAYLOADS'])/'Snapshot.ps1'}),
        ]:
            identifier = identity()
            self.record(script, windows.submit(workspace, self.args.name, identifier,
                self.root/'tests'/script, 'system', inputs=inputs, metadata={'kind': 'input-fixture'}))
            observed = self.wait(identifier)
            assert observed['principal'] == 'NT AUTHORITY\\SYSTEM' and observed['sessionId'] == 0, observed
            path = self.directory/result_name
            windows.download(workspace, self.args.name, windows.ROOT+'\\jobs\\'+identifier+'\\'+result_name, path)
            result = json.loads(path.read_text(encoding='utf-8-sig'))
            assert result['state'] == 'passed', result
            self.record('verified-'+result_name, result)

    def native_fixture(self):
        sys.path.insert(0, os.environ['WB_OPERATION_SOURCES'])
        from wb import windows
        from wb.workspace import Workspace
        workspace = Workspace(self.root, {"stateRoot": self.args.state_root})
        built = self.cli("native-build", "devbox", "run", "--name", self.args.name, "--purpose", "build", "--script", str(self.root / "tests/WindowsBuildFixture.ps1"))
        assert built["exitCode"] == 0, built
        identifier = built["operationId"]
        observed = self.wait(identifier)
        assert 'Arch: x86_64' in observed['logs']['stdout.log'] and 'Arch: i386' in observed['logs']['stdout.log'], observed
        metadata = self.directory / "fixture-build.json"
        windows.download(workspace, self.args.name, windows.ROOT + "\\jobs\\" + identifier + "\\fixture-build.json", metadata)
        result = json.loads(metadata.read_text(encoding='utf-8-sig'))
        boundary = 'C:\\WinBoatDev\\build\\' + identifier + '\\'
        files = []
        for file in result['files']:
            assert file['path'].startswith(boundary), file
            relative = windows.windows_relative(file['path'][len(boundary):])
            files.append(windows.download(workspace, self.args.name, file['path'], self.directory / 'native' / relative,
                         expected={'sha256': file['sha256'], 'size': file['size']}))
        self.record('verified-native-return', {'schemaVersion':1,'state':'verified','files':files})
        submitted = self.tool('devbox_run', {'name':self.args.name,'purpose':'system','script':str(self.root / 'tests/WindowsLoadedFixture.ps1'),'arguments':[identifier]})
        assert submitted['exitCode'] == 0, submitted
        self.wait(submitted['operationId'], via_mcp=True)
        windows.download(workspace, self.args.name, windows.ROOT + '\\jobs\\' + submitted['operationId'] + '\\loaded-fixture.json', self.directory / 'loaded-fixture.json')

    def reboot_fixture(self):
        bundle = self.directory / 'reboot-bundle'
        bundle.mkdir()
        data = b'WinBoat reboot transaction fixture\n'
        (bundle / 'fixture.dll').write_bytes(data)
        manifest = {'schemaVersion':1,'fixtureId':'reboot-' + self.directory.name[:16],'rebootRequired':True,
                    'files':[{'path':'fixture.dll','sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}]}
        path = bundle / 'manifest.json'
        path.write_text(json.dumps(manifest))
        pending = self.tool('devbox_install', {'name':self.args.name,'manifest':str(path),'fixture':True,'background':False})
        assert pending['exitCode'] == 3010 and pending['result']['state'] == 'reboot-required', pending
        identifier = pending['result']['transactionId']
        boot = pending['result']['bootTime']
        restarted = self.cli('required-restart', 'devbox','restart','--name',self.args.name,'--timeout','180')
        assert restarted['exitCode'] == 0, restarted
        # Transport can return before sshd is ready. Observation retries only
        # authenticate/read the preserved task; they never repeat installation.
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            status = self.cli('reboot-reconnect','devbox','job','status','--name',self.args.name,'--id',identifier)
            if 'result' in status:
                break
            time.sleep(5)
        else:
            raise AssertionError('Authenticated guest reconnect failed after reboot')
        resumed = self.tool('devbox_install', {'name':self.args.name,'resume':identifier,'background':False})
        assert resumed['exitCode'] == 0 and resumed['result']['bootTime'] != boot, resumed
        rolled_back = self.tool('devbox_install', {'name':self.args.name,'rollback':identifier,'background':False})
        assert rolled_back['exitCode'] == 0, rolled_back

    def install_fixture(self):
        bundle = self.directory / "bundle"
        bundle.mkdir()
        data = b"WinBoat transaction fixture: not a graphics DLL\n"
        (bundle / "fixture.dll").write_bytes(data)
        manifest = {"schemaVersion": 1, "fixtureId": "acceptance-" + self.directory.name[:16],
                    "files": [{"path": "fixture.dll", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}]}
        path = bundle / "manifest.json"
        path.write_text(json.dumps(manifest))
        failed = self.cli("injected-install-failure", "devbox", "install", "--name", self.args.name, "--manifest", str(path), "--fixture", "--failure-after-copy")
        assert failed["exitCode"] == 1 and failed["details"]["observation"]["state"] == "failed", failed
        identifier = failed["details"]["jobId"]
        resumed = self.tool("devbox_install", {"name": self.args.name, "resume": identifier, "background": False})
        assert resumed["exitCode"] == 0, resumed
        registry = self.tool("devbox_registry_reconcile", {"name": self.args.name, "background": False})
        assert registry["exitCode"] == 0, registry
        entries = registry["result"]["entries"]
        relevant = [entry for entry in entries if manifest["fixtureId"] in entry["path"]]
        assert len(relevant) == 2 and all(entry["installed"] == "verified" for entry in relevant), relevant
        mutation = bundle / "mutate.ps1"
        mutation.write_text("[IO.File]::AppendAllText('C:\\WinBoatDev\\fixtures\\" + manifest["fixtureId"] + "\\fixture.dll','manual drift')\n"
                            "Set-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WinBoatDev\\Fixtures\\" + manifest["fixtureId"] + "' -Name Path -Value 'C:\\manual.dll'\n")
        submitted = self.tool("devbox_run", {"name": self.args.name, "purpose": "system", "script": str(mutation)})
        assert submitted["exitCode"] == 0, submitted
        self.wait(submitted["operationId"], via_mcp=True)
        drift = self.tool("devbox_registry_reconcile", {"name": self.args.name, "background": False})
        assert drift["exitCode"] == 0 and drift["result"]["state"] == "drift", drift
        relevant = [entry for entry in drift["result"]["entries"] if manifest["fixtureId"] in entry["path"]]
        assert len(relevant) == 2 and all(entry["installed"] == "drift" for entry in relevant), relevant
        rollback = self.tool("devbox_install", {"name": self.args.name, "rollback": identifier, "background": False})
        assert rollback["exitCode"] == 0, rollback


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--seconds", type=int, default=12)
    parser.add_argument("--native", action='store_true', help='Build, hash-return and test loaded/replaced/reloaded x64/x86 DLL fixtures')
    parser.add_argument("--build-target", action='append', default=[], help='Additionally build and verify this component through MCP')
    parser.add_argument("--reboot", action='store_true', help='Reboot this explicitly named guest to recover a restart-required fixture install')
    parser.add_argument("--component-only", action='store_true', help='Run only the selected native/component/reboot checks, skipping the control suite')
    parser.add_argument("--large-request", action='store_true', help='Verify a durable request beyond the Windows encoded-command size limit')
    parser.add_argument("--input-fixtures", action='store_true', help='Verify input trees and snapshot extraction/resume boundaries on Windows')
    parser.add_argument("--full-stack", action='store_true', help='Build clean pinned full stacks through CLI then MCP, install/reboot, and verify interactive graphics and loaded identities')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600:
        parser.error("seconds must be between 1 and 600")
    acceptance = Acceptance(args)
    try:
        acceptance.run()
    finally:
        if acceptance.mcp:
            acceptance.mcp.terminate()
            acceptance.mcp.wait(timeout=10)


if __name__ == "__main__":
    main()
