# Stage 5 — Agent-driven developer experience

Status: planned. Prerequisites: Stages 1 and 4.

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
