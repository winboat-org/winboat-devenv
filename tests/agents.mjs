import test from "node:test";
import TOML from "@iarna/toml";
import { Fixture, assert, fs, path, write, mcp } from "./helpers.mjs";

test("agent setup preserves policies, hooks and servers with backups and idempotent merges", (t) => {
  const f = new Fixture(t),
    codex = path.join(f.root, ".codex/config.toml");
  const original =
    '# personal comment\napproval_policy = "on-request"\nmodel = "custom"\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.winboat]\nenabled = false\n[mcp_servers.winboat.tools.repo_push]\napproval_mode = "prompt"\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "personal-hook"\n';
  write(codex, original);
  write(
    path.join(f.root, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "other" } } }),
  );
  write(
    path.join(f.root, ".claude/settings.local.json"),
    JSON.stringify({
      permissions: { defaultMode: "default" },
      env: { PERSONAL: "keep" },
    }),
  );
  const prepared = f.wb("setup", "--agents", "all");
  const value = TOML.parse(fs.readFileSync(codex, "utf8"));
  assert.equal(value.approval_policy, "on-request");
  assert.equal(value.model, "custom");
  assert.equal(value.mcp_servers.other.command, "other");
  assert.equal(value.mcp_servers.winboat.enabled, false);
  assert.equal(
    value.mcp_servers.winboat.tools.repo_push.approval_mode,
    "prompt",
  );
  assert.equal(value.mcp_servers.winboat.args[1], f.root);
  assert.equal(value.shell_environment_policy.set.WB_CODEX_WORKSPACE, f.root);
  assert.equal(value.hooks.PreToolUse[0].hooks[0].command, "personal-hook");
  assert.ok(
    prepared.agents.files.some(
      (file) =>
        file.backup && fs.readFileSync(file.backup, "utf8") === original,
    ),
  );
  assert.equal(fs.statSync(codex).mode & 0o777, 0o600);
  const claude = JSON.parse(
    fs.readFileSync(path.join(f.root, ".claude/settings.local.json")),
  );
  assert.equal(claude.permissions.defaultMode, "default");
  assert.equal(claude.env.PERSONAL, "keep");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, ".mcp.json"))).mcpServers.other
      .command,
    "other",
  );
  assert.ok(
    f
      .wb("setup", "--agents", "all")
      .agents.files.every((file) => !file.changed),
  );
});

test("agent setup refuses conflicting Bash hooks and symlinked config without partial merges", (t) => {
  const f = new Fixture(t),
    codex = path.join(f.root, ".codex/config.toml");
  const original =
    '[shell_environment_policy.set]\nBASH_ENV = "/personal/hook"\n';
  write(codex, original);
  assert.match(
    f.wb("setup", "--agents", "all", { check: false }).error,
    /BASH_ENV/,
  );
  assert.equal(fs.readFileSync(codex, "utf8"), original);
  assert.ok(!fs.existsSync(path.join(f.root, ".mcp.json")));
  fs.unlinkSync(codex);
  const outside = path.join(f.base, "personal.toml");
  write(outside, 'model = "keep"\n');
  fs.symlinkSync(outside, codex);
  assert.match(
    f.wb("setup", "--agents", "codex", { check: false }).error,
    /symlinked/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), 'model = "keep"\n');
});

test("parallel MCP clients reuse one durable mutation and wait on the same completion", async (t) => {
  const f = new Fixture(t),
    a = mcp(t, f),
    b = mcp(t, f);
  await Promise.all(
    [a, b].map((client) =>
      client.rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stage5", version: "1" },
      }),
    ),
  );
  const calls = await Promise.all(
    [a, b].map((client) =>
      client.rpc("tools/call", {
        name: "repo_sync",
        arguments: { repos: ["venus-protocol"], requestId: "one-mutation" },
      }),
    ),
  );
  const first = calls[0].result.structuredContent.result;
  assert.equal(calls[1].result.structuredContent.result.jobId, first.jobId);
  const done = await b.rpc("tools/call", {
    name: "job_wait",
    arguments: { id: first.jobId, timeout: 20 },
  });
  assert.equal(done.result.structuredContent.result.state, "succeeded");
  assert.equal(done.result.structuredContent.result.terminal, true);
  assert.equal(
    fs
      .readdirSync(path.join(f.root, ".state/jobs"))
      .filter((file) => /^op-.*\.json$/.test(file)).length,
    1,
  );
  const conflict = await a.rpc("tools/call", {
    name: "repo_sync",
    arguments: { repos: ["winboat"], requestId: "one-mutation" },
  });
  assert.equal(conflict.result.isError, true);
  assert.match(conflict.result.structuredContent.error, /different arguments/);
  const logs = await b.rpc("tools/call", {
    name: "job_logs",
    arguments: { id: first.jobId, limit: 32 },
  });
  assert.ok(logs.result.structuredContent.result.bytes <= 32);
  const invalid = await a.rpc("tools/call", {
    name: "job_wait",
    arguments: { id: first.jobId, timeout: 51 },
  });
  assert.equal(invalid.error.code, -32602);
});

test("large MCP receipts retain full evidence and expose bounded pages by ID", async (t) => {
  const f = new Fixture(t);
  f.wb("repo", "sync", "--repo", "venus-protocol");
  const p = path.join(f.root, "repos/helios/venus-protocol");
  for (let i = 0; i < 250; i++)
    write(path.join(p, "untracked-" + i + "-" + "x".repeat(90)), "dirty");
  const client = mcp(t, f);
  await client.rpc("initialize", { protocolVersion: "2025-11-25" });
  const value = (
    await client.rpc("tools/call", {
      name: "repo_status",
      arguments: { repos: ["venus-protocol"] },
    })
  ).result.structuredContent;
  assert.equal(value.truncated, true);
  assert.ok(JSON.stringify(value).length < 16000);
  const full = JSON.parse(
    fs.readFileSync(
      path.join(f.root, ".state/mcp-results", value.fullResult.id + ".json"),
    ),
  );
  assert.equal(full.result.repositories[0].changes.length, 250);
  const chunk = (
    await client.rpc("tools/call", {
      name: "evidence_read",
      arguments: { id: value.fullResult.id, offset: 0, limit: 64 },
    })
  ).result.structuredContent.result;
  assert.equal(chunk.bytes, 64);
  assert.equal(chunk.nextOffset, 64);
  assert.equal(chunk.eof, false);
  const failed = await client.rpc("tools/call", {
    name: "evidence_read",
    arguments: { id: "../../local.json" },
  });
  assert.equal(failed.result.isError, true);
});

test("wait timeout preserves work and completion retains native failure status", (t) => {
  const f = new Fixture(t),
    id = "op-" + "a".repeat(32);
  write(
    path.join(f.root, ".state/jobs", id + ".json"),
    JSON.stringify({ jobId: id, state: "queued" }),
  );
  assert.equal(
    f.wb("job", "wait", "--id", id, "--timeout", "0").timedOut,
    true,
  );
  write(
    path.join(f.root, ".state/jobs", id + ".json"),
    JSON.stringify({ jobId: id, state: "failed", exitCode: 42 }),
  );
  const result = f.wb("job", "wait", "--id", id, "--timeout", "0", {
    check: false,
  });
  assert.equal(result.exitCode, 42);
  assert.equal(result.result.terminal, true);
  write(
    path.join(f.root, ".state/jobs", id + ".json"),
    JSON.stringify({
      jobId: id,
      state: "failed",
      exitCode: 194,
      operation: { schemaVersion: 1, state: "reboot-required", exitCode: 3010 },
    }),
  );
  const reboot = f.wb("job", "wait", "--id", id, "--timeout", "0", {
    check: false,
  });
  assert.equal(reboot.exitCode, 3010);
  assert.equal(reboot.state, "reboot-required");
  assert.equal(reboot.result.processExitCode, 194);
});

test("queued launch recovery retains the original job and rejects duplicate execution", async (t) => {
  const f = new Fixture(t),
    id = "op-" + "b".repeat(32);
  const directory = path.join(f.root, ".state/jobs", id);
  write(path.join(directory, "stderr.log"), "");
  write(
    path.join(f.root, ".state/jobs", id + ".json"),
    JSON.stringify({
      schemaVersion: 1,
      jobId: id,
      state: "queued",
      workspace: f.root,
      arguments: ["repo", "status", "--repo", "venus-protocol"],
      log: path.join(directory, "stderr.log"),
      result: path.join(directory, "result.json"),
    }),
  );
  assert.equal(f.wb("job", "resume", "--id", id).jobId, id);
  assert.equal(
    f.wb("job", "wait", "--id", id, "--timeout", "20").state,
    "succeeded",
  );
  const before = fs.readFileSync(path.join(directory, "result.json"));
  assert.equal(f.wb("job", "run", "--id", id, { check: false }).exitCode, 2);
  assert.deepEqual(
    fs.readFileSync(path.join(directory, "result.json")),
    before,
  );
});
