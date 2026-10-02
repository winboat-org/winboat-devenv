# Configuration

`shell/` contains native devenv auto-activation fragments for Bash, Zsh and Fish.
Load the applicable hook once during shell setup and allow this checkout with
`devenv allow`. [Activation documentation](../docs/auto-activation.md) also covers
Nushell and direnv/editor integration. These are portable templates; host startup
files and the per-user trust database remain outside tracked configuration.

`local.example.json` describes configuration Stage 1 will implement; devbox
fields are consumed from Stage 3 onward. It is an example today: the scaffold
does not load it. Copy it to ignored `local.json` when configuring that stage.
Paths are workspace-relative unless explicitly overridden locally. `auto`
means discover and record a usable choice or report a missing prerequisite.

The guest account and directories are environment defaults independent of the
host username. Keys, generated passwords, signing certificates, ISO identity,
resolved ports and runtime paths belong in ignored `.state/`. Package and SDK
versions belong in the later tracked provisioning lock. Fork overrides stay
local unless preparing an explicit fork-specific pin change.

`.mcp.json` registers devenv's existing stdio MCP for Claude Code.
`agents/codex.toml.example` has the equivalent Codex configuration. Start clients
in this workspace. Generate project Codex config into ignored
`.codex/config.toml` when writable; merge existing config instead of replacing
it. Add the Node control-plane MCP once its executable exists in Stage 1.
The samples neither register an absent devbox server nor change approval policy.

Formats follow the official [Codex MCP docs](https://developers.openai.com/codex/mcp/)
and [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).
