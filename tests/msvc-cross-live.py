"""Run Linux-built MSVC /MT fixtures in an explicitly selected Windows guest."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ['WB_OPERATION_SOURCES'])
from wb import windows
from wb.common import identity, write_json
from wb.workspace import Workspace

parser = argparse.ArgumentParser()
parser.add_argument('--name', required=True)
parser.add_argument('--state-root', required=True)
parser.add_argument('--build-result', required=True)
args = parser.parse_args()
workspace = Workspace(Path(os.environ['WB_WORKSPACE_ROOT']), {'stateRoot': args.state_root})
build = json.loads(Path(args.build_result).read_text())
assert len(build) == 1
artifact = Path(build[0]['outputs']['out'])
operation = identity()
evidence = Path(args.state_root) / 'msvc-cross-acceptance' / operation
evidence.mkdir(parents=True)
write_json(evidence / 'nix-build.json', build)
started = windows.submit(workspace, args.name, operation,
    workspace.root / 'tests/WindowsMsvcCrossFixture.ps1', 'system',
    inputs={f'probe-{a}.exe': artifact / a / 'probe.exe' for a in ('x64', 'x86')},
    metadata={'kind': 'msvc-cross-fixture', 'hostDerivation': build[0]['drvPath']})
write_json(evidence / 'start.json', started)
observed = windows.wait(workspace, args.name, operation)
assert observed['principal'] == 'NT AUTHORITY\\SYSTEM' and observed['sessionId'] == 0, observed
write_json(evidence / 'completion.json', observed)
result_path = evidence / 'runtime.json'
windows.download(workspace, args.name, windows.ROOT + '\\jobs\\' + operation + '\\msvc-cross-fixture.json', result_path)
result = json.loads(result_path.read_text(encoding='utf-8-sig'))
assert result['state'] == 'passed', result
print(json.dumps({'state': 'passed', 'operationId': operation, 'artifact': str(artifact),
    'evidence': str(evidence), 'runtime': result}), flush=True)
