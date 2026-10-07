# WinBoat development environment

A staged, Nix-defined workspace for Helios, WinBoat and their graphics, compute
and desktop dependencies. The target is one control plane usable by maintainers,
CI, Claude Code, Codex and other MCP clients, with reproducible source/tool pins
and a headless Windows development VM running the Helios QEMU fork.

**Stages 1–4 passed their measured current-host checks.** Stage 4 built the
complete graphics stack from clean pins through CLI and MCP, installed each
package, and verified all 12 mapped DLLs, resident Helios kernel code and 13
interactive graphics workloads in both repeats. See
[full acceptance evidence](docs/evidence/stage-04-acceptance.json).
Windows dependencies use seven Linux MSVC cross-build targets: DXVK, vkd3d and
Mesa in x64/x86, plus CLVK with its loaders and probes. LLVM/Clang produce no
debug symbols; runtime symbols remain in component artifacts, and the install
bundle contains zero PDBs. The primary Helios build uses Windows because its
pinned WDK build scripts reject Linux hosts. See [build usage](docs/builds.md).

Stage 3's unmodified blank-disk creation, all 14 installed tools, signing/driver
load, autologin and local mirror checks passed. NVIDIA devboxes use Nix-pinned
rootless Podman with workspace-private, vendor-generated CDI. The host supplies
its graphics driver and device access; the workspace supplies the toolkit and
hooks. The acceptance guest explicitly upgraded to the corrected QEMU artifact
with its previous image/closure and guest identity retained. The original
development guest remains preserved. See [runtime evidence](docs/evidence/stage-04-runtime.json),
[devbox usage](docs/devbox.md) and [validation](docs/validation.md).

Acceptance covers this development environment and its measured workloads.
Driver conformance, another physical host and second-account Windows boot
remain unverified. WinBoat/Electron still need their
complete fixed dependency closures. Stage 5 now supplies merged client setup,
automatic SSH configuration, durable waits, retry IDs and bounded evidence.
Its measured client/protocol and live build/install/loaded-code checks passed;
see [Stage 5 evidence](docs/evidence/stage-05-acceptance.json) for client/UI limits.
Stage 6 now supplies exact component workflows, migrated installer sources and
a prebuilt-only candidate bundler. The virglrenderer hosted artifact passed CI
and download verification. QEMU, catalog-verifier and ADL artifacts also verified;
DXVK/vkd3d builds passed but need corrected metadata exports. The complete hosted
artifact set, candidate assembly
and fresh installer runtime
acceptance remain pending; see [release usage](docs/releases.md). Stage 7 remains
planned.

## Start here

Nix, devenv and native auto-activation must already be installed and configured.
Enter the trusted checkout to activate its locked environment. This workspace
does not install shell hooks or modify host startup files; see
[activation](docs/auto-activation.md) for checkout trust and explicit execution.

Agents use the connected WinBoat MCP tools for routine workspace operations,
including setup, repository status, builds, devbox control and jobs. See the
[MCP tool mapping](docs/workspace.md#mcp-and-durable-jobs). The following CLI
examples are for terminal use, CI and checks of CLI behavior.

```sh
wb setup
wb doctor --json
wb repo plan --subset helios
wb repo sync --subset helios --background --json
wb job status --id <returned-job-id> --json
wb repo branch --repo helios --name development
```

Use the committed lock; `devenv update` is an explicit dependency refresh. Use
the individual [CI commands](docs/releases.md#composed-ci-environments) in hosted
Actions. Development imports that CI base and adds editing, agent and devbox tools.
Use commands directly in an activated or refreshed shell. `devenv shell -- wb ...`
supplies the environment when it is absent, such as in CI. Codex can refresh
its Bash command environment automatically using `wb-codex-config`; see
[agent configuration](config/README.md). Restart Codex after merging its
settings and reconnect MCP servers after changing their execution environment.
The workspace uses devenv's native hooks without direnv or `.envrc`.
The CLI, MCP proxy, durable jobs, devbox supervisor and Codex refresh run on the
same locked Node.js runtime. Nix installs their pinned npm dependencies.
Shell entry does not clone repositories, commit files, start a VM or install a
driver.

Stage 1 fetched all twelve seed objects from canonical repositories. Stage 2
adds recipe commits and coherent parent/child pins. Stage 6 published the six
component repositories and verified their exact canonical remote revisions;
see [implementation evidence](docs/evidence/stage-06-implementation.json).
The locked CLI and modules use
unmodified upstream devenv. See [validation](docs/validation.md) for measured
build checks and the native Fish activation limitation for paths with spaces.

## Implementation

The [stage index](docs/stages/README.md) lists dependencies, deliverables and
acceptance gates. [The Stage 4 handoff](docs/handoffs/stage-04.md) records the
completed checkpoint and preservation boundaries.
[Workspace usage](docs/workspace.md) covers commands, publication recovery,
forks and MCP jobs.
[Agent workflows](docs/agents.md) cover `wb setup --agents all`, client connection
checks, contributor forks, durable completion and build/install verification.
[Build usage](docs/builds.md) covers target selection, source modes, guest
dispatch plans and artifact/closure verification.
[Devbox usage](docs/devbox.md) covers exact artifact selection, persistent state,
the attachable VNC viewer, automatic desktop login and offline toolchain.
[Windows control](docs/windows-control.md) covers Stage 4's shared tasks,
verified snapshots, transactions, inventory and measured acceptance scope.
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
