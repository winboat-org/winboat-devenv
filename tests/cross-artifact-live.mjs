// Verify host artifacts imported into one explicit guest, including CLVK loads.
import assert from "node:assert/strict";
import * as windows from "../tools/wb/windows.mjs";
import {
  identity,
  write_json,
  readJSON,
  mkdir,
  path,
  env,
} from "../tools/wb/common.mjs";
import { Workspace } from "../tools/wb/workspace.mjs";
import { arguments_, output } from "./live-common.mjs";
const args = arguments_({ manifest: { type: "string", multiple: true } });
assert.ok(args.manifest?.length, "--manifest is required");
const ws = new Workspace(env.WB_WORKSPACE_ROOT, { stateRoot: args.state_root }),
  op = identity(),
  evidence = path.join(ws.state, "cross-artifact-acceptance", op),
  imports = [];
mkdir(evidence);
for (const p of args.manifest) {
  const imported = await windows.import_artifact(
      ws,
      args.name,
      p,
      "release",
      "development",
    ),
    reused = await windows.import_artifact(
      ws,
      args.name,
      p,
      "release",
      "development",
    );
  assert.ok(reused.reusedVerifiedMirror);
  assert.equal(reused.operationId, imported.operationId);
  const manifest = readJSON(p);
  imports.push({
    target: manifest.target,
    import: imported,
    files: manifest.files,
  });
}
write_json(path.join(evidence, "imports.json"), imports);
assert.ok(imports.some((r) => r.target === "clvk-helios"));
const remote = windows.ROOT + "\\jobs\\" + op;
const started = await windows.submit(
  ws,
  args.name,
  op,
  path.join(ws.root, "tests/WindowsCrossArtifactFixture.ps1"),
  "system",
  ["-Specification", remote + "\\imports.json"],
  false,
  { kind: "cross-artifact-acceptance" },
  { "imports.json": path.join(evidence, "imports.json") },
);
write_json(path.join(evidence, "start.json"), started);
const observed = await windows.wait(ws, args.name, op);
write_json(path.join(evidence, "completion.json"), observed);
windows.download(
  ws,
  args.name,
  remote + "\\cross-artifact-fixture.json",
  path.join(evidence, "runtime.json"),
);
const runtime = readJSON(path.join(evidence, "runtime.json"));
assert.equal(runtime.state, "passed");
assert.equal(runtime.dlls.length, 4);
output({ state: "passed", operationId: op, imports, runtime, evidence });
