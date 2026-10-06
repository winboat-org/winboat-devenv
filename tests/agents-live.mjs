// Client/protocol acceptance without a model turn or permission-policy changes.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import TOML from "@iarna/toml";
import { randomUUID } from "node:crypto";
import { write_json } from "../tools/wb/common.mjs";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    "state-root": { type: "string" },
  },
});
const root = process.env.WB_WORKSPACE_ROOT;
const area = path.join(root, ".state/stage05");
const relocated = path.join(area, "workspace with spaces");
const wb = process.env.WB_LIVE_COMMAND;
function command(command, args, cwd = root) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}
function cli(args, cwd = root) {
  const r = command(wb, ["--workspace", cwd, "--json", ...args], cwd);
  const value = JSON.parse(r.stdout);
  assert.equal(r.status, 0, JSON.stringify(value));
  return value;
}
class RPC {
  constructor(command, args, cwd) {
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.id = 0;
    this.errors = "";
    this.child.stderr.on("data", (d) => (this.errors += d));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const value = JSON.parse(line);
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
        else pending.resolve(value.result);
      }
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("client exited: " + this.errors));
      }
      this.pending.clear();
    });
  }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(method + " timed out: " + this.errors.slice(-2000)));
        }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }
  close() {
    this.lines.close();
    this.child.kill();
  }
}
const initialize = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "stage5-acceptance", version: "1" },
};
const summary = {
  schemaVersion: 1,
  stage: 5,
  observedAt: new Date().toISOString(),
  runId: "stage05-" + randomUUID(),
  state: "running",
  pathContainsSpaces: true,
  clients: {},
  checks: {},
  limitations: [],
};
fs.mkdirSync(relocated, { recursive: true });
const sources = command("git", [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
])
  .stdout.split("\0")
  .filter(Boolean);
for (const file of sources) {
  const target = path.join(relocated, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
const current = cli(["repo", "list"]).result.repositories;
write_json(path.join(relocated, "local.json"), {
  schemaVersion: 1,
  workspace: {
    repositoryOverrides: Object.fromEntries(
      current
        .filter((r) => !r.parent)
        .map((r) => [
          r.repository,
          { path: r.path, adopt: true, readOnly: true },
        ]),
    ),
    ...(values["state-root"] ? { stateRoot: values["state-root"] } : {}),
  },
});
cli(["setup", "--agents", "all"], relocated);
const codexConfig = TOML.parse(
  cli(["agents", "config", "--client", "codex"], relocated).result.content,
);
const refreshed = spawnSync(
  "bash",
  [
    "--noprofile",
    "--norc",
    "-c",
    codexConfig.hooks.PreToolUse[0].hooks[0].command,
  ],
  {
    cwd: relocated,
    env: { ...process.env, BASH_ENV: "" },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  },
);
assert.equal(refreshed.status, 0, refreshed.stderr);
const bash = spawnSync(
  "bash",
  ["--noprofile", "--norc", "-c", "command -v wb; command -v git"],
  {
    cwd: relocated,
    env: {
      ...process.env,
      ...codexConfig.shell_environment_policy.set,
      _WB_CODEX_ENV: "",
    },
    encoding: "utf8",
  },
);
assert.equal(bash.status, 0, bash.stderr);
assert.ok(
  bash.stdout
    .split("\n")
    .filter(Boolean)
    .every((p) => p.startsWith("/nix/store/")),
  bash.stdout,
);
summary.checks.commandRefresh = {
  state: "passed",
  commands: bash.stdout.trim().split("\n"),
  exportMode:
    fs.statSync(path.join(relocated, ".state/codex/current")).mode & 0o777,
};
const generated = JSON.parse(
  cli(["agents", "config", "--client", "mcp"], relocated).result.content,
).mcpServers;
const connections = [];
try {
  for (const [name, server] of Object.entries(generated)) {
    const client = new RPC(server.command, server.args, relocated);
    connections.push(client);
    const info = await client.rpc("initialize", initialize);
    client.notify("notifications/initialized");
    const tools = (await client.rpc("tools/list", {})).tools;
    summary.checks[name] = {
      initialized: true,
      server: info.serverInfo,
      tools: tools.map((t) => t.name),
    };
    if (name === "devenv") {
      const tool = tools.find((t) => t.name === "search_options");
      const inspection = await client.rpc("tools/call", {
        name: tool.name,
        arguments: { query: "packages" },
      });
      write_json(path.join(area, "nix-inspection.json"), inspection);
      assert.ok(!inspection.isError, JSON.stringify(inspection));
      summary.checks.nixInspection = "passed";
    } else {
      const observed = await client.rpc("tools/call", {
        name: "repo_status",
        arguments: {},
      });
      assert.ok(!observed.isError);
      summary.checks.repositoryStatus = "passed";
      if (values.name) {
        const guest = await client.rpc("tools/call", {
          name: "devbox_guest_status",
          arguments: {
            name: values.name,
            requestId: summary.runId + "-relocated-status",
          },
        });
        assert.ok(!guest.isError, JSON.stringify(guest));
        summary.checks.guestStatusJobId = guest.structuredContent.result.jobId;
        const completed = await client.rpc("tools/call", {
          name: "job_wait",
          arguments: { id: summary.checks.guestStatusJobId, timeout: 45 },
        });
        assert.ok(!completed.isError, JSON.stringify(completed));
        summary.checks.guestStatus = completed.structuredContent.result.state;
      }
    }
  }
  const codexVersion = command("codex", ["--version"]).stdout.trim();
  // Explicit per-process server configuration exercises the installed client
  // without granting the copied checkout trust or modifying user-global settings.
  const overrides = Object.entries(generated).flatMap(([name, server]) => [
    "-c",
    `mcp_servers.${name}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},startup_timeout_sec=120,tool_timeout_sec=60}`,
  ]);
  const codex = new RPC("codex", ["app-server", ...overrides], relocated);
  connections.push(codex);
  await codex.rpc("initialize", {
    clientInfo: { name: "stage5-acceptance", version: "1" },
    capabilities: { experimentalApi: true },
  });
  codex.notify("initialized");
  const thread = await codex.rpc("thread/start", {
    cwd: relocated,
    ephemeral: true,
  });
  const threadId = thread.thread.id;
  const statuses = await codex.rpc("mcpServerStatus/list", { threadId });
  write_json(path.join(area, "codex-status.json"), statuses);
  summary.clients.codex = {
    version: codexVersion,
    initialized: true,
    servers: statuses.data
      ?.filter((s) => ["devenv", "winboat"].includes(s.name))
      .map((s) => ({
        name: s.name,
        tools: Object.keys(s.tools ?? {}),
      })),
  };
  for (const [server, tool, args] of [
    ["winboat", "repo_status", {}],
    ["devenv", "search_options", { query: "packages" }],
  ]) {
    const result = await codex.rpc("mcpServer/tool/call", {
      threadId,
      server,
      tool,
      arguments: args,
    });
    write_json(path.join(area, "codex-" + server + ".json"), result);
    assert.ok(!result.isError, JSON.stringify(result));
  }
  summary.clients.codex.toolCalls = "passed";
  if (values.name) {
    const guest = await codex.rpc("mcpServer/tool/call", {
      threadId,
      server: "winboat",
      tool: "devbox_guest_status",
      arguments: {
        name: values.name,
        requestId: summary.runId + "-codex-guest-status",
      },
    });
    assert.ok(!guest.isError, JSON.stringify(guest));
    const jobId = guest.structuredContent.result.jobId;
    const completed = await codex.rpc("mcpServer/tool/call", {
      threadId,
      server: "winboat",
      tool: "job_wait",
      arguments: { id: jobId, timeout: 45 },
    });
    assert.ok(!completed.isError, JSON.stringify(completed));
    summary.clients.codex.guestStatus =
      completed.structuredContent.result.state;
  }
  const claude = command("claude", ["mcp", "get", "winboat"], relocated);
  write_json(path.join(area, "claude-connection.json"), {
    status: claude.status,
    stdout: claude.stdout,
    stderr: claude.stderr,
  });
  summary.clients.claude = {
    version: command("claude", ["--version"]).stdout.trim(),
    configurationLoaded: claude.status === 0,
    connected: /Connected/.test(claude.stdout),
    pendingApproval: /Pending approval/.test(claude.stdout),
  };
  const claudeNix = command("claude", ["mcp", "get", "devenv"], relocated);
  summary.clients.claude.nixConnected =
    claudeNix.status === 0 && /Connected/.test(claudeNix.stdout);
  write_json(path.join(area, "claude-nix-connection.json"), {
    status: claudeNix.status,
    stdout: claudeNix.stdout,
    stderr: claudeNix.stderr,
  });
  if (!summary.clients.claude.connected)
    summary.limitations.push(
      "Claude project-server trust/approval is pending; its diagnostic did not prove a live tool call.",
    );
  summary.state = summary.limitations.length
    ? "implemented-partial-acceptance"
    : "client-protocol-checks-passed";
} catch (error) {
  summary.state = "failed";
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  for (const c of connections) c.close();
  write_json(path.join(area, "clients-summary.json"), summary);
  process.stdout.write(JSON.stringify(summary) + "\n");
}
