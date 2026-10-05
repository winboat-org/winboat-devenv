import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { refresh } from "../nix/scripts/codex-refresh.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb refresh spaces ")),
    command = path.join(root, "fake-devenv.cjs");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    command,
    "#!" +
      process.execPath +
      "\n" +
      'const fs = require("node:fs"); fs.writeFileSync("invocation.json",JSON.stringify({args:process.argv.slice(2),bashEnv:process.env.BASH_ENV}));' +
      'const data=fs.readFileSync("response","utf8"); if(data==="failure"){process.stderr.write("fixture failed");process.exit(7);} process.stdout.write(data);\n',
    { mode: 0o755 },
  );
  return {
    root,
    command,
    response: path.join(root, "response"),
    current: path.join(root, ".devenv/codex/current"),
  };
}
test("refresh publishes a private complete generation without sourcing BASH_ENV", (t) => {
  const f = fixture(t),
    saved = process.env.BASH_ENV;
  process.env.BASH_ENV = "/must-not-be-sourced";
  t.after(() => {
    if (saved === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = saved;
  });
  fs.writeFileSync(
    f.response,
    'export WB_TEST_VALUE="first"\nunset WB_OLD_VALUE\n',
  );
  refresh(f.root, f.command);
  const value = fs.readFileSync(f.current, "utf8");
  assert.match(
    value,
    /^# [a-f0-9]{64}\nexport WB_TEST_VALUE="first"\nunset WB_OLD_VALUE\n$/,
  );
  assert.equal(fs.statSync(f.current).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.root, "invocation.json"))),
    { args: ["--quiet", "direnv-export"] },
  );
  fs.writeFileSync(f.response, 'export WB_TEST_VALUE="second"\n');
  refresh(f.root, f.command);
  const updated = fs.readFileSync(f.current, "utf8");
  assert.notEqual(updated, value);
  assert.ok(updated.endsWith('export WB_TEST_VALUE="second"\n'));
  assert.equal(fs.readdirSync(path.dirname(f.current)).length, 1);
});
test("empty and failed exports preserve the last successful generation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.response, 'export WB_TEST_VALUE="valid"\n');
  refresh(f.root, f.command);
  const before = fs.readFileSync(f.current);
  for (const response of ["", "failure"]) {
    fs.writeFileSync(f.response, response);
    assert.throws(() => refresh(f.root, f.command));
    assert.deepEqual(fs.readFileSync(f.current), before);
  }
});
test("refresh executable explicitly denies stale execution on failure", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.response, "failure");
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../nix/scripts/codex-refresh.mjs"),
      f.root,
      f.command,
    ],
    { encoding: "utf8" },
  );
  assert.ifError(result.error);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /fixture failed/);
  assert.ok(!fs.existsSync(f.current));
});
