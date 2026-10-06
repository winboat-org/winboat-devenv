# Stage 5 — Agent-driven developer experience

Status: implemented; measured current-host client/protocol, contributor fixture
and build/install/runtime checks passed. Prerequisites: Stages 1 and 4.

[Acceptance evidence](../evidence/stage-05-acceptance.json) records exact client
versions and scope, 80 native checks, fresh primary/package builds, installation
resume, 13 graphics workloads, 12 mapped DLLs and resident kernel code. Claude
connection diagnostics and Codex programmatic tool calls were exercised;
interactive trust UI and Claude model-driven turns were not. See the
[handoff](../handoffs/stage-05.md) for preserved failures and migration boundaries.

`wb setup --agents codex|claude|mcp|all` merges project settings and retains
private originals without changing user-global settings or approval policies.
Nix packages both core server launchers and command refresh. SSH keys, host-key
pinning and the derived private configuration are automatic during devbox setup
and connections. No separate SSH setup command is needed.

Host and guest waits preserve durable IDs across disconnects. Explicit retry
IDs deduplicate background submissions; oversized MCP results retain complete
receipts with bounded log/evidence reads. See [agent workflows](../agents.md)
for configuration ownership, contributor flow and reproducible client checks.

`wb-codex-config` renders checkout-specific configuration from locked Nix
definitions. Its local command hook checks devenv's dependency cache before
each Bash execution, then publishes a generation for the command shell.
See [configuration](../../config/README.md). The earlier refresh slice alone did
not establish the client, guest-operation or contributor acceptance below.
The refresh hook and host control plane now use Node.js. Generated Codex MCP
settings launch the Nix `wb` application directly, with no additional shell entry.
Command exports are handed off through private `.state/codex/` files. Project
code does not access devenv's internal state directory. Node formatting uses
Prettier from the locked Nix input through `wb-format` and `wb-format-check`.

## Outcome

A maintainer or contributor can start Claude Code, Codex or another MCP client
from any checkout path and use the same repository, Nix and Windows operations
without manual connection setup or a duplicated build workflow.

## Implementation

Extend `wb setup --agents <client>` to render/merge project client configuration
for devenv's Nix MCP and the Node WinBoat control-plane MCP. Keep AGENTS.md as
shared instructions and CLAUDE.md as its import. Verify configuration against
current official client documentation; do not replace user-global settings or
silently disable trust/approval controls. Configure startup/tool timeouts and
bounded result output for real workloads. A tool's presence in configuration is
not proof that it initialized or exposes the expected schema.

Agents use the advertised WinBoat MCP tools by default for workspace operations.
Use the CLI for explicit CLI requests, CLI/shell integration checks or operations
without an MCP equivalent. Inspect missing or stale connections and report the
limitation before falling back. Run shell commands directly in the activated
or refreshed locked environment; explicit `devenv shell -- <command>` entry is
needed when that environment is absent. Codex command refresh runs before Bash
execution and does not restart existing MCP processes; reconnect them after Nix
execution or schema changes.

Use generated workspace-local SSH config/keys and the command-layer purpose
semantics for guest access. Support remote Windows build hosts via explicit
local configuration if needed. Provide Nix/SSH support integrations or project
skills that call the same declared tools. Assess actual plugins only when they
add a necessary capability; record exact source/version/hash and installation
instructions. Avoid unpinned `npx -y` downloads and imaginary plugin names.
Pin Node/MCP dependencies and install through Nix/the selected package lock.

Provide concise workflows for first-run setup, fork contribution, repository
checkpoint/publish, component builds, devbox install, inventory checks, desktop
probes and packaging. Routine authorized steps proceed without extra permission
prompts; media, account credentials and genuinely missing external inputs remain
explicit inputs. AGENTS.md/CONTRIBUTING.md require meaningful scoped checkpoint
commits, preserved dirty work, evidence-backed status and docs ownership.

Long operations must return a durable job handle with a usable wait/notification
path, structured completion and retained evidence. Starting another client or
losing stdio must not discard work. Keep discovery/results compact; offer scoped
log/artifact reads instead of dumping complete build logs into an agent prompt.

## Acceptance

From a new workspace path, launch both clients and verify MCP initialize,
tools/list, Nix inspection, repository status and a guest build/status request.
Confirm generated launch paths work with spaces and require no particular host
username or SSH alias. Exercise parallel client reads and a serialized mutation
without duplicate jobs or corrupt pin/registry state.

Follow a contributor fork workflow and a build/install/interactive-smoke workflow
using only the documented commands/tools. Check credentials/personal configs
remain ignored, stdout stays protocol-clean, errors include evidence, and an
unavailable optional plugin does not prevent core setup. Record which client
versions, plugins and paths were actually tested.
