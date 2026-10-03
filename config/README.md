# Configuration

`shell/` contains native devenv auto-activation fragments for Bash, Zsh and Fish.
Load the applicable hook once during shell setup and allow this checkout with
`devenv allow`. [Activation documentation](../docs/auto-activation.md) also covers
Nushell and direnv/editor integration. These are portable templates; host startup
files and the per-user trust database remain outside tracked configuration.

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

`.mcp.json` registers devenv's stdio MCP and the Stage 1 `winboat` server for
Claude Code. `agents/codex.toml.example` has equivalent Codex configuration.
The workspace server launches with `devenv shell -- wb mcp`; no npm installation
is required. Start clients in this workspace. Project Codex configuration lives in ignored
`.codex/config.toml` when writable; merge existing config instead of replacing
it. Both servers use the locked Nix environment for workspace commands.
The samples neither register an absent devbox server nor change approval policy.

Formats follow the official [Codex MCP docs](https://developers.openai.com/codex/mcp/)
and [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).
