# Implementation stages

**Stages 2–4 passed their measured current-host acceptance.** The genuine Nix
and provisioning locks are unchanged. The six Helios component repositories and
their coherent parent/child pins have been published and verified.
WinBoat/Electron fixed dependency
closures, another physical host and second-account Windows boot remain pending.
See [validation](../validation.md) for measured checks and the upstream native
Fish activation limitation; interactive activation tests were excluded at the
maintainer's request.

[Stage 4 acceptance](../evidence/stage-04-acceptance.json) records two complete
clean-pinned builds and installs, through CLI then MCP. Each passed 13 graphics
workloads, 12 mapped DLL identities and the actual resident Helios kernel code.
Seven dependency targets cross-compile on Linux; the primary driver retains its
documented Windows WDK build requirement. LLVM/Clang generate no debug symbols,
and runtime symbols remain outside the install bundle in component artifacts.
[Runtime evidence](../evidence/stage-04-runtime.json) preserves the QEMU fallback,
same-INF replacement and Win32 calling-convention failures and corrected checks.
These checks establish development-environment acceptance on this host.

The [Node control-plane rewrite](../validation.md#native-node-control-plane-rewrite-2026-10-06)
passed 71 native tests, live CLI/MCP control fixtures and a real component build.
The new supervisor closure builds, but replacement-container boot remains
pending. The retained guest stopped with a recorded QEMU/Mesa cleanup crash;
this check does not extend the historical Stage 4 graphics acceptance or complete
Stage 5 client workflows.

| Stage | Scope | Prerequisites | Status |
| --- | --- | --- | --- |
| 0 | devenv initialization, inventory/seed pins, docs and agent guidance | Empty workspace | Complete |
| [1](01-workspace.md) | Setup/doctor, repo sync, checkpoints, push pins, forks, initial Node MCP | 0 | Complete for requested repository/MCP scope; activation limitation documented |
| [2](02-builds.md) | Per-repo Nix recipes, native/cross builds, ABI and output contracts | 1 | Native/cross acceptance passed; full WinBoat/Electron application closures pending |
| [3](03-devbox.md) | Containerized headless Windows provisioning, shared workspace and viewer | 2 host QEMU/renderer outputs | Podman/NVIDIA current-host acceptance passed; alternate UID preparation passed; corrected-artifact Docker repeat needs daemon space; second account Windows boot/other host pending |
| [4](04-windows-control.md) | Windows builds, Helios installation, strict inventory, devbox MCP | 2, 3 | Accepted on current host: clean CLI/MCP stack builds, installs, 13 graphics workloads, 12 mapped DLLs and resident kernel code passed; publication/conformance remain separate |
| [5](05-agents.md) | Claude/Codex setup, SSH/Nix integrations, agent workflows | 1, 4 | Implemented; measured current-host client/protocol, contributor fixtures and build/install/runtime checks passed; interactive client UI/Claude model turns not exercised |
| [6](06-ci-bundles.md) | Component CI and bundling-only root CI, installer relocation | 2, 4 | Implemented locally; hosted builds/assembly and fresh installer runtime acceptance pending |
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
preconfigured Nix + devenv auto-activation -> enter trusted checkout
-> wb setup -> wb doctor -> wb repo sync --subset ...
-> wb build host-stack -> wb devbox create --iso <local.iso>
-> wb build guest-stack -> wb devbox install --manifest <artifacts.json>
-> wb devbox registry verify -> optional wb devbox viewer open
```

Each step is callable through MCP, with durable job IDs for long operations.
The complete command contract is in [architecture](../architecture.md).
