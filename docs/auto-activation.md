# Automatic activation

Nix, devenv and native auto-activation are assumed installed and configured.
Entering a trusted checkout activates its locked environment; leaving it
deactivates the environment. Nested directories retain the active environment.
The workspace does not install hooks or inspect or modify host startup files.
It provides no `.envrc` and does not require direnv.

For a new or relocated checkout, run `devenv allow` once from its root if it is
not yet trusted. Trust is managed by devenv, outside `wb setup` and `wb doctor`.
`wb setup` only creates ignored workspace configuration and state.

Codex can use the Nix-generated configuration from `wb-codex-config` to refresh
its command environment automatically; see [agent configuration](../config/README.md).
The hook checks devenv's native dependency cache immediately before each Bash
command and refreshes when its recorded inputs change. It requires no additional
watcher or host service. Run commands directly in an activated or refreshed
environment; use `devenv shell -- <command>` when that environment is absent,
such as in CI.

Agents use the connected WinBoat MCP tools for routine workspace operations;
see the [tool mapping](workspace.md#mcp-and-durable-jobs). Codex's Bash refresh
does not update existing commands or MCP processes. Restart/reconnect an affected
server after changes to Nix execution definitions, locked inputs or MCP schemas.

Activation requires input downloads/a built shell. The locked upstream devenv
CLI/modules are unmodified. Its native Fish launcher currently fails when the
initialization path contains spaces because that path is emitted unquoted.
Use explicit noninteractive execution for such workspaces.
Interactive activation regression tests are outside this
project's validation scope; we do not maintain an upstream shell implementation.
