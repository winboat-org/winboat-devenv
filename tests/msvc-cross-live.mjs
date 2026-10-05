// Run Linux-built MSVC /MT fixtures in an explicitly selected Windows guest.
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
const args = arguments_({ "build-result": { type: "string" } });
assert.ok(args.build_result, "--build-result is required");
const ws = new Workspace(env.WB_WORKSPACE_ROOT, { stateRoot: args.state_root }),
  build = readJSON(args.build_result);
assert.equal(build.length, 1);
const artifact = build[0].outputs.out,
  operation = identity(),
  evidence = path.join(ws.state, "msvc-cross-acceptance", operation);
mkdir(evidence);
write_json(path.join(evidence, "nix-build.json"), build);
const started = await windows.submit(
  ws,
  args.name,
  operation,
  path.join(ws.root, "tests/WindowsMsvcCrossFixture.ps1"),
  "system",
  [],
  false,
  { kind: "msvc-cross-fixture", hostDerivation: build[0].drvPath },
  Object.fromEntries(
    ["x64", "x86"].map((a) => [
      "probe-" + a + ".exe",
      path.join(artifact, a, "probe.exe"),
    ]),
  ),
);
write_json(path.join(evidence, "start.json"), started);
const observed = await windows.wait(ws, args.name, operation);
assert.equal(observed.principal, "NT AUTHORITY\\SYSTEM");
assert.equal(observed.sessionId, 0);
write_json(path.join(evidence, "completion.json"), observed);
const resultPath = path.join(evidence, "runtime.json");
windows.download(
  ws,
  args.name,
  windows.ROOT + "\\jobs\\" + operation + "\\msvc-cross-fixture.json",
  resultPath,
);
const runtime = readJSON(resultPath);
assert.equal(runtime.state, "passed");
output({
  state: "passed",
  operationId: operation,
  artifact,
  evidence,
  runtime,
});
