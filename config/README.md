# Configuration

`wb setup --agents codex|claude|mcp|all` now merges the Stage 5 client settings.
It preserves unrelated servers, personal hooks and approval policies, and keeps
exact changed originals in private state. Restart clients after generation;
handle their normal trust prompts. See [agent workflows](../docs/agents.md) for
configuration ownership, durable waits, bounded evidence and client acceptance.

Nix, devenv and native auto-activation are existing host prerequisites.
Shell startup files and the per-user trust database remain outside this
workspace's configuration; see [activation](../docs/auto-activation.md).

`defaults.json` supplies tracked Stage 1 settings. `wb setup` creates ignored
`local.json` at the workspace root if absent; existing settings are preserved.
`local.example.json` shows the schema, including implemented devbox fields.
[Devbox usage](../docs/devbox.md) describes the implemented fields and
measured provisioning checks. Settings merge defaults, local configuration, then
invocation overrides.
Paths resolve relative to the discovered workspace root. `--workspace`,
`--repositories-root`, `--state-root` and `--out-root` support explicit discovery
and layout choices; source/state/output roots must be disjoint.

`workspace.repositoryOverrides` maps a repository ID to an object with `path`,
`adopt: true` and optional `readOnly: true`. A nested child retains its declared
parent layout and inherits a parent's read-only setting. This is the only way
to adopt an external reference checkout. `workspace.remotes` maps IDs to local
fetch URL overrides; canonical identities remain in Nix. `forkNamespace` and
`gitTransport` (`https` or `ssh`) select contributor fork remotes. See
[workspace usage](../docs/workspace.md) for publication and explicit fork pins.

The guest account and directories are environment defaults independent of the
host username. Keys, generated passwords, signing certificates, ISO identity,
resolved ports and runtime paths belong in ignored `.state/`. Package and SDK
versions and input status belong in `provision.lock.json`; unresolved inputs do
not count as a verified guest baseline. Fork overrides stay
local unless preparing an explicit fork-specific pin change.

`.mcp.json` registers devenv's stdio MCP and the `winboat` server for Claude Code.
Agents use WinBoat MCP for routine workspace, repository, build, devbox and job
operations. Discover the tools advertised by the current connection; see the
[tool mapping](../docs/workspace.md#mcp-and-durable-jobs). Use the CLI for
CLI/shell integration checks, explicit CLI requests and operations without an
MCP equivalent. Inspect and report an unavailable or stale connection before
using a fallback.

`wb-codex-config` prints the locked Codex configuration for the current
checkout, including MCP servers and automatic command-environment
refresh. Merge its output into an existing `.codex/config.toml`; for a new
configuration, create `.codex/` and save the output there. Regenerate it after
moving the checkout or updating the locked devenv CLI.
`agents/codex.toml.example` is the minimal MCP-only alternative.
The generated Codex server entry launches the absolute Nix `wb` application
directly. Minimal MCP templates use `devenv shell -- wb mcp` when the client does
not already have the environment. Nix installs the pinned Node dependencies;
no manual npm installation is required. Once connected,
agents invoke MCP tools directly. Start clients in this workspace. Project
Codex configuration lives in ignored `.codex/config.toml` when writable; merge
existing config instead of replacing it. Both servers use the locked Nix
environment for workspace commands.
The samples neither register an absent devbox server nor change approval policy.

The generated Codex `PreToolUse` hook checks devenv's own evaluation cache
before each Bash command. Refresh occurs at command start when devenv detects
a change to its recorded inputs, including imported/read files, Nix
configuration and the lock. Successful exports are published atomically
under ignored `.state/codex/`; command shells apply the current generation and
restore removed variables using the locked CLI's environment-diff helpers.
Nested shells using the same generation retain their existing environment.
A failed refresh denies the command instead of executing with stale tools.
Run shell commands directly after the hook supplies their environment.
Restart Codex after merging its configuration. Existing running commands and
MCP processes keep their environment until restarted; restart/reconnect the
affected server after changing its Nix execution definitions, locked inputs
or MCP schemas.

Only devenv manages its internal state directory. Project code obtains exports
through the devenv CLI and stores its own command handoff under `.state/`.

This integration uses supported local Codex command hooks. Cloud orchestration
does not support project command hooks, including when execution is local; use
explicit locked devenv execution in that mode. See the official
[hook support and configuration](https://learn.chatgpt.com/docs/hooks).

Formats follow the official [Codex MCP docs](https://developers.openai.com/codex/mcp/)
and [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).
