# Documentation

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Workspace, command, devbox and artifact contracts |
| [Automatic activation](auto-activation.md) | Native shell hooks and direnv/editor integration |
| [Repositories](repositories.md) | Inventory, subsets, pins, fork and submodule policy |
| [Workspace control plane](workspace.md) | Setup, sync, scoped publication, forks and durable MCP jobs |
| [Builds](builds.md) | Native/cross targets, Windows dispatch and immutable artifact contracts |
| [Stages](stages/README.md) | Sequenced implementation and acceptance gates |
| [Stage 1 handoff](handoffs/stage-01.md) | Original implementation prompt |
| [Stage 2 handoff](handoffs/stage-02.md) | Original build implementation prompt |
| [Stage 3 handoff](handoffs/stage-03.md) | Next-session devbox implementation prompt |
| [Reference audit](reference-audit.md) | Existing tooling and evidence to preserve |
| [Validation](validation.md) | Workspace acceptance evidence and remaining limitations |
| [Personal docs](user/README.md) | Ignored machine notes |

Environment setup, VM lifecycle, agent integration, shared release contracts and
cross-project operations belong here. Architecture, driver internals, compiler
flags and component debugging belong in the repository that owns them. Link
between repositories instead of copying competing versions of the same guide.

Use descriptive kebab-case names, relative links within this repository, and
commit-specific links when discussing a reference snapshot. Every stage records
its status, prerequisites, implementation steps and acceptance evidence. Update
the living document when decisions change; retain useful decisions and measured
limits without creating a new session log for every agent turn.

Personal environment details belong under `docs/user/`, which Git ignores except
for its generic README. Secrets and keys belong in local state, never in docs.
Publish generalized procedures only after removing host-specific facts. Review
Git's staged diff before every documentation commit.
