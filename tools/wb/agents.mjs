import TOML from "@iarna/toml";
import {
  path,
  env,
  Failure,
  read,
  readJSON,
  exists,
  atomic_write,
  locked,
  hash,
  symlink,
  within,
} from "./common.mjs";

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export function render(ws, client) {
  const runtime = readJSON(env.WB_AGENT_RUNTIME);
  const servers = {
    devenv: { command: runtime.nixMcp, args: [ws.root] },
    winboat: { command: env.WB_COMMAND, args: ["--workspace", ws.root, "mcp"] },
  };
  if (client === "codex") {
    return {
      features: { shell_snapshot: false },
      shell_environment_policy: {
        inherit: "all",
        set: { BASH_ENV: runtime.bashEnv, WB_CODEX_WORKSPACE: ws.root },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [
              {
                type: "command",
                command: [
                  runtime.node,
                  runtime.refresh,
                  ws.root,
                  runtime.devenv,
                ]
                  .map(shellQuote)
                  .join(" "),
                timeout: 120,
                statusMessage: "Refresh locked devenv environment",
              },
            ],
          },
        ],
      },
      mcp_servers: Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [
          name,
          { ...server, startup_timeout_sec: 120, tool_timeout_sec: 60 },
        ]),
      ),
    };
  }
  if (client === "mcp")
    return {
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [
          name,
          { type: "stdio", ...server },
        ]),
      ),
    };
  // Tracked project config stays portable. Both clients start in the locked shell.
  if (client === "claude")
    return {
      mcpServers: {
        devenv: {
          type: "stdio",
          command: "devenv",
          args: ["mcp"],
          timeout: 60000,
        },
        winboat: {
          type: "stdio",
          command: "wb",
          args: ["--workspace", ".", "mcp"],
          timeout: 60000,
        },
      },
    };
  throw new Failure("unsupported agent client", 2);
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Failure(name + " must be an object", 2);
  return value;
}
function mergeServers(current, desired) {
  object(current, "MCP servers");
  for (const [name, server] of Object.entries(desired)) {
    const old = current[name] ?? {};
    object(old, "MCP server " + name);
    // Preserve approvals, enablement, per-tool policies and unrelated servers.
    if (
      old.url ||
      old.transport === "http" ||
      old.type === "http" ||
      old.type === "sse"
    )
      throw new Failure(
        "conflicting transport for managed MCP server " + name,
        2,
      );
    current[name] = { ...old, ...server, ...(old.env ? { env: old.env } : {}) };
  }
}
export function mergeCodex(current, desired) {
  object(current, "Codex config");
  current.mcp_servers ??= {};
  mergeServers(current.mcp_servers, desired.mcp_servers);
  current.features ??= {};
  object(current.features, "features").shell_snapshot = false;
  current.shell_environment_policy ??= {};
  const policy = object(
    current.shell_environment_policy,
    "shell_environment_policy",
  );
  policy.inherit ??= "all";
  policy.set ??= {};
  object(policy.set, "shell_environment_policy.set");
  const existing = policy.set.BASH_ENV;
  if (
    existing &&
    existing !== desired.shell_environment_policy.set.BASH_ENV &&
    !/^\/nix\/store\/[^/]+-winboat-codex-bash-env$/.test(existing)
  )
    throw new Failure(
      "existing BASH_ENV conflicts with WinBoat refresh; merge it explicitly",
      2,
    );
  Object.assign(policy.set, desired.shell_environment_policy.set);
  current.hooks ??= {};
  object(current.hooks, "hooks");
  const hooks = current.hooks.PreToolUse ?? [];
  if (!Array.isArray(hooks))
    throw new Failure("PreToolUse must be an array", 2);
  // Remove only the prior workspace hook, retaining other Bash hooks.
  current.hooks.PreToolUse = hooks
    .map((entry) => ({
      ...entry,
      hooks: entry.hooks.filter(
        (hook) =>
          !(
            hook.statusMessage === "Refresh locked devenv environment" &&
            typeof hook.command === "string" &&
            hook.command.includes("winboat-codex-refresh.mjs")
          ),
      ),
    }))
    .filter((entry) => entry.hooks.length)
    .concat(desired.hooks.PreToolUse);
  return current;
}

function guarded(ws, target) {
  for (let p = target; within(p, ws.root) && p !== ws.root; p = path.dirname(p))
    if (symlink(p))
      throw new Failure("refusing symlinked agent configuration: " + p, 2);
}
export async function setup(ws, client, operationId) {
  const clients = client === "all" ? ["codex", "claude", "mcp"] : [client];
  return locked(path.join(ws.state, "locks/agents.lock"), () => {
    const writes = [];
    for (const selected of clients) {
      const desired = render(ws, selected);
      const target =
        selected === "codex"
          ? path.join(ws.root, ".codex/config.toml")
          : selected === "claude"
            ? path.join(ws.root, ".mcp.json")
            : path.join(ws.state, "agents/mcp.json");
      guarded(ws, target);
      const before = exists(target) ? read(target) : null;
      let content;
      if (selected === "codex")
        content = TOML.stringify(
          mergeCodex(before ? TOML.parse(before) : {}, desired),
        );
      else {
        const current = before ? JSON.parse(before) : {};
        object(current, "MCP config");
        current.mcpServers ??= {};
        mergeServers(current.mcpServers, desired.mcpServers);
        content = JSON.stringify(current, null, 2) + "\n";
      }
      writes.push({ target, before, content, client: selected });
      if (selected === "claude") {
        const target = path.join(ws.root, ".claude/settings.local.json");
        guarded(ws, target);
        const before = exists(target) ? read(target) : null;
        const settings = before ? JSON.parse(before) : {};
        object(settings, "Claude settings");
        settings.env ??= {};
        object(settings.env, "Claude env");
        settings.env.MCP_TIMEOUT ??= "120000";
        settings.env.MCP_TOOL_TIMEOUT ??= "60000";
        settings.env.MAX_MCP_OUTPUT_TOKENS ??= "6000";
        writes.push({
          target,
          before,
          content: JSON.stringify(settings, null, 2) + "\n",
          client: selected,
        });
      }
    }
    const files = [];
    for (const { target, before, content, client } of writes) {
      let backup = null;
      if (before !== null && before !== content) {
        backup = path.join(
          ws.state,
          "agents/backups",
          operationId,
          hash(target) + ".original",
        );
        atomic_write(backup, before, 0o600);
      }
      if (before !== content) atomic_write(target, content, 0o600);
      files.push({ client, path: target, changed: before !== content, backup });
    }
    const result = {
      state: "prepared",
      clients,
      files,
      externalStep:
        "Restart clients to load settings; approve project trust/server prompts normally. Reconnect MCP after execution or schema changes.",
    };
    ws.journal(operationId, { kind: "agent-setup", ...result });
    return result;
  });
}
export function config(ws, client) {
  const value = render(ws, client);
  return {
    client,
    content:
      client === "codex"
        ? TOML.stringify(value)
        : JSON.stringify(value, null, 2) + "\n",
  };
}
