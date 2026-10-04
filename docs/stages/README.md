# Implementation stages

**Stage 2 native/cross and Stage 3 current-host acceptance passed.**
The genuine Nix lock is unchanged. Six recipe commits and matching parent/child
pins are local only; canonical publication is pending. Stage 4 DXVK/vkd3d x64/x86
Windows execution and native KMD/UMD/Mesa/CLVK builds passed; clean pinned stack
build/install/loaded-state acceptance and
WinBoat/Electron dependency closure completion remain pending. Native UMD x86
and the baseline fixture's resident kernel-code comparison passed. See
[validation](../validation.md) for measured checks and the upstream native Fish
activation limitation; interactive activation tests were excluded at the
maintainer's request.

Host MSVC cross builds now pass for DXVK, vkd3d and Mesa x64/x86, plus CLVK,
loaders and probes. CLVK retains runtime symbols while LLVM/Clang generate none.
Verified Windows imports and CLVK/loader DLL loads passed; full stack graphics
acceptance remains pending. See [cross evidence](../evidence/stage-04-cross.json).

| Stage | Scope | Prerequisites | Status |
| --- | --- | --- | --- |
| 0 | devenv initialization, inventory/seed pins, docs and agent guidance | Empty workspace | Complete |
| [1](01-workspace.md) | Setup/doctor, repo sync, checkpoints, push pins, forks, initial Node MCP | 0 | Complete for requested repository/MCP scope; activation limitation documented |
| [2](02-builds.md) | Per-repo Nix recipes, native/cross builds, ABI and output contracts | 1 | Native/cross acceptance passed; guest execution and full app/compiler closures pending |
| [3](03-devbox.md) | Containerized headless Windows provisioning, shared workspace and viewer | 2 host QEMU/renderer outputs | Podman/NVIDIA current-host acceptance passed; alternate UID preparation passed; corrected-artifact Docker repeat needs daemon space; second account Windows boot/other host pending |
| [4](04-windows-control.md) | Windows builds, Helios installation, strict inventory, devbox MCP | 2, 3 | In progress: real DXVK x64/x86 builds, eight-minute task, mapped-image and transaction/reboot checks passed; full component/loaded-stack acceptance pending |
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
