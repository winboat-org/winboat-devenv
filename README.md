# WinBoat development environment

A staged, Nix-defined workspace for Helios, WinBoat and their graphics, compute
and desktop dependencies. The target is one control plane usable by maintainers,
CI, Claude Code, Codex and other MCP clients, with reproducible source/tool pins
and a headless Windows development VM running the Helios QEMU fork.

**Stages 1–3 passed their measured native/cross and current-host devbox checks:**
repository/MCP operations, six composable component recipes, isolated native
graphics builds, a Windows DLL cross-build and immutable artifact manifests.
Stage 4 is in progress: real DXVK/vkd3d x64/x86 MSVC builds, shared CLI/MCP Windows
tasks and transaction recovery have passed on a fresh guest. Native KMD/UMD,
Mesa and CLVK builds passed; clean pinned stack repeats, installation and
loaded-stack acceptance remain pending. Linux MSVC cross builds now pass for
DXVK, vkd3d and Mesa in both architectures, and for CLVK with zero LLVM/Clang
compiler PDBs. Host-built CLVK and loaders also loaded successfully in Windows;
see [cross dependency evidence](docs/evidence/stage-04-cross.json). See the
[Windows evidence](docs/evidence/stage-04-control.json) and
[native checkpoint](docs/evidence/stage-04-native.json). UMD x86 and the baseline
fixture's resident kernel-code comparison passed. Helios/Mesa/CLVK candidates
have Nix-declared offline inputs; WinBoat/Electron still need their complete
fixed dependency closures. Stage 3's
host lifecycle, unmodified blank-disk creation, all 14 installed tools,
post-reboot autologin, signing/driver load and local mirror build checks passed.
NVIDIA devboxes now use Nix-pinned rootless Podman with workspace-private,
vendor-generated CDI. The host supplies its graphics driver and device access;
the workspace supplies the toolkit and hooks. See [devbox usage](docs/devbox.md)
and [validation](docs/validation.md) for runtime-specific checks and limits.

The Stage 4 QEMU EGL fallback crash is fixed and the task-owned acceptance guest
has explicitly upgraded to the new clean host artifact. Its startup verified
loaded host images and NVIDIA Vulkan availability; isolated-overlay health and
shutdown passed. Fresh CLI/MCP full-stack graphics checks are still pending.
See [runtime evidence](docs/evidence/stage-04-runtime.json).

## Start here

Install Git, Nix and devenv using their official instructions; no distro or
system configuration is assumed. The scaffold was initialized with devenv
2.4.0. [devenv getting started](https://devenv.sh/getting-started/) describes
installation and shell commands.

```sh
devenv shell
wb setup
wb doctor --json
wb repo plan --subset helios
wb repo sync --subset helios --background --json
wb job status --id <returned-job-id> --json
wb repo branch --repo helios --name development
```

Use the committed lock; `devenv update` is an explicit dependency refresh. Use
`devenv shell -- wb ...` for noninteractive commands. Optional
[native activation](docs/auto-activation.md) uses `wb setup --activation <shell>`;
direnv-based editors/shells can use the tracked `.envrc` and `direnv allow`.
Shell entry does not clone repositories, commit files, start a VM or install a
driver.

Stage 1 fetched all twelve seed objects from canonical repositories. Stage 2
adds local recipe commits and coherent parent/child pins, verified through
ignored local remote overrides. Those new commits have not been published;
canonical reachability remains pending. The locked CLI and modules use
unmodified upstream devenv. See [validation](docs/validation.md) for measured
build checks and the native Fish activation limitation for paths with spaces.

## Implementation

The [stage index](docs/stages/README.md) lists dependencies, deliverables and
acceptance gates. Continue with [the Stage 4 handoff](docs/handoffs/stage-04.md).
[Workspace usage](docs/workspace.md) covers commands, publication recovery,
forks and MCP jobs.
[Build usage](docs/builds.md) covers target selection, source modes, guest
dispatch plans and artifact/closure verification.
[Devbox usage](docs/devbox.md) covers exact artifact selection, persistent state,
the attachable VNC viewer, automatic desktop login and offline toolchain.
[Windows control](docs/windows-control.md) covers Stage 4's shared tasks,
verified snapshots, transactions, inventory and remaining acceptance gates.
[Architecture](docs/architecture.md) defines the shared CLI/MCP, devbox and
artifact contracts. [Repository policy](docs/repositories.md) describes subsets,
pins and the current nested layout.

Environment and shared integration docs live in [docs/](docs/README.md).
Personal machine notes live in ignored [docs/user/](docs/user/README.md).
[Reference audit](docs/reference-audit.md) records the existing tooling.
[Configuration](config/README.md) describes local settings and agent templates;
no machine-specific paths or credentials are committed.

Component recipes belong in the six Helios repositories; other recipes belong
here. Component CI builds individual artifacts. This repository's release CI
only verifies and bundles existing artifacts and a prebuilt installer.
User-supplied Windows media and generated guest credentials remain local.
