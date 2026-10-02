# Implementation stages

**Stage 2 native/cross build acceptance is implemented; Stage 3 is next.**
The genuine Nix lock is unchanged. Six recipe commits and matching parent/child
pins are local only; canonical publication is pending. Windows MSVC/WDK execution
and WinBoat/Electron/CLVK dependency closure completion remain pending. See
[validation](../validation.md) for measured checks and the upstream native Fish
activation limitation; interactive activation tests were excluded at the
maintainer's request.

| Stage | Scope | Prerequisites | Status |
| --- | --- | --- | --- |
| 0 | devenv initialization, inventory/seed pins, docs and agent guidance | Empty workspace | Complete |
| [1](01-workspace.md) | Setup/doctor, repo sync, checkpoints, push pins, forks, initial Node MCP | 0 | Complete for requested repository/MCP scope; activation limitation documented |
| [2](02-builds.md) | Per-repo Nix recipes, native/cross builds, ABI and output contracts | 1 | Native/cross acceptance passed; guest execution and full app/compiler closures pending |
| [3](03-devbox.md) | Containerized headless Windows provisioning, shared workspace and viewer | 2 host QEMU/renderer outputs | Planned |
| [4](04-windows-control.md) | Windows builds, Helios installation, strict inventory, devbox MCP | 2, 3 | Planned |
| [5](05-agents.md) | Claude/Codex setup, SSH/Nix integrations, agent workflows | 1, 4 | Planned |
| [6](06-ci-bundles.md) | Component CI and bundling-only root CI, installer relocation | 2, 4 | Planned |
| [7](07-migration.md) | Retire duplicate tooling/submodules, docs cleanup, fresh-host acceptance | 1–6 | Planned |

Each stage ends with a reviewable checkpoint, concrete validation and an updated
status here. Missing runtime prerequisites must be recorded as pending checks;
do not mark a stage accepted based only on parsing, a plan or a successful copy.
Implement coherent slices within a stage and commit validated checkpoints.

Stages 5 and 6 can proceed independently once their prerequisites are met.
Local Windows builds can be operational before remote CI. Later migration must
not invalidate the original acceptance evidence without replacement checks.

The intended first-run path after implementation is:

```text
install Nix + devenv -> wb setup -> wb doctor -> wb repo sync --subset ...
-> wb build host-stack -> wb devbox create --iso <local.iso>
-> wb build guest-stack -> wb devbox install --manifest <artifacts.json>
-> wb devbox registry verify -> optional wb devbox viewer open
```

Each step is callable through MCP, with durable job IDs for long operations.
The complete command contract is in [architecture](../architecture.md).
