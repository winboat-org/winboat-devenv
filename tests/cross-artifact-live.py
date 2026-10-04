"""Verify host artifacts imported into one explicit guest, including CLVK DLL loads."""
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
parser.add_argument('--manifest', action='append', required=True)
args = parser.parse_args()
ws = Workspace(Path(os.environ['WB_WORKSPACE_ROOT']), {'stateRoot': args.state_root})
op = identity()
evidence = ws.state/'cross-artifact-acceptance'/op
evidence.mkdir(parents=True)
imports = []
for path in args.manifest:
    imported = windows.import_artifact(ws, args.name, path, 'release', 'development')
    reused = windows.import_artifact(ws, args.name, path, 'release', 'development')
    assert reused['reusedVerifiedMirror'] and reused['operationId'] == imported['operationId']
    manifest = json.loads(Path(path).read_text())
    imports.append({'target':manifest['target'], 'import':imported, 'files':manifest['files']})
write_json(evidence/'imports.json', imports)
assert any(record['target'] == 'clvk-helios' for record in imports)
remote = windows.ROOT+'\\jobs\\'+op
started = windows.submit(ws, args.name, op, ws.root/'tests/WindowsCrossArtifactFixture.ps1', 'system',
    ['-Specification',remote+'\\imports.json'], inputs={'imports.json':evidence/'imports.json'},
    metadata={'kind':'cross-artifact-acceptance'})
write_json(evidence/'start.json', started)
observed = windows.wait(ws, args.name, op)
write_json(evidence/'completion.json', observed)
windows.download(ws,args.name,remote+'\\cross-artifact-fixture.json',evidence/'runtime.json')
result = json.loads((evidence/'runtime.json').read_text(encoding='utf-8-sig'))
assert result['state'] == 'passed' and len(result['dlls']) == 4, result
print(json.dumps({'state':'passed','operationId':op,'imports':imports,'runtime':result,'evidence':str(evidence)}))
