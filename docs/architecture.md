# Architecture and implementation contracts

This document specifies the target system. Stages 1 and 2 implement workspace,
repository and native/cross build operations with their Node MCP proxy. The
stage index tracks Windows execution, devbox and release delivery; [build
usage](builds.md) records the current artifact and dispatch contracts. Stage 3
adds the shared devbox lifecycle and exact-closure container; complete Windows
acceptance remains pending.

## Workspace and configuration

The repository root is discovered, with `repos/` for managed checkouts,
`.state/` for local runtime state/secrets/receipts, `out/` for exported artifacts
and `docs/user/` for personal notes. Every location supports a validated local
override. Tracked defaults describe the environment; no host username, home
directory, GPU vendor, render node, SSH alias, bridge, display server, container
daemon or system-installed SDK is assumed.

Configuration precedence is tracked defaults, ignored local configuration, then
explicit invocation arguments. Resolve paths relative to the discovered root;
validate boundaries before copying or deleting. Schema versions apply to config,
pins, manifests, job receipts, artifacts and guest inventories. Changes must be
reported and migrated rather than accepted as silent meaning changes.

Nix supplies host tools and declares every operation. OS facilities such as KVM,
device permissions, a container runtime and a display socket are detected by
`wb doctor`; unsupported capabilities receive concrete diagnostics. Native
Linux build/VM support is the first acceptance target. Other platforms may use
supported cross builds or a remote devbox but must not claim local KVM support.
Installing prerequisites is distinct from entering the shell.

Native devenv hooks activate the trusted workspace when entering its directory
and deactivate on exit. Onboarding supports Bash, Zsh, Fish and Nushell, reports
missing hook setup and performs `devenv allow` during explicit activation setup.
Trust remains local to each checkout. The tracked `.envrc` supports direnv-based
editors; use one activation mechanism per shell. Noninteractive execution invokes
the Nix environment explicitly and does not depend on prompt hooks.

## Control plane

Use one `wb` command surface for setup, repository operations, builds, devbox
lifecycle, jobs, inventory and bundling. Commands and their execution environment
are Nix-defined. PowerShell payloads are shared checked-in files invoked by
those commands, never divergent shell and MCP implementations.

The MCP server is Node.js (TypeScript is acceptable), running over stdio by
default. It validates typed arguments and invokes the same Nix command through
argument arrays. MCP exposes the control plane from Stage 1 and gains devbox
lifecycle tools in Stage 3 and Windows execution/inventory tools in Stage 4.
Native OpenSSH and devenv's own MCP provide SSH/Nix support;
additional plugins are selected and pinned in Stage 5 based on demonstrated
needs. Keep credentials and client-specific launch paths out of shared config.

Planned command families are `wb setup`, `wb doctor`, `wb repo ...`, `wb build
...`, `wb devbox ...`, `wb job ...`, `wb bundle ...` and `wb mcp`. `--json` returns
a versioned result with operation ID, actual state, exit code, evidence paths
and any external step still required. Human progress goes to stderr. Long jobs
return durable IDs, retain logs and support cancellation/status/resume across
MCP disconnects. Success is terminal only when the operation's evidence is
complete. Do not busy-poll build logs through the model.

Git interception is scoped to the Nix environment, preserving normal Git
argument semantics and exit codes. It uses an absolute Nix Git executable to
avoid recursion. A pre-push hook cannot establish remote push success; use a
post-success wrapper plus a recoverable journal. Clients that bypass PATH must
use the wrapper explicitly or the control plane. Never modify global Git config.

## Source and build reproducibility

Immutable source pins and Nix input locks are different registries. A build
resolves a dependency closure and records all input SHAs, source hashes where
required, Nix lock identity, compiler/tool versions, architecture, configuration
and compiler flags. Editable development builds additionally record the source
diff digest; a dirty build must never be described as only a clean commit.

Each of helios, qemu-helios, dxvk, virglrenderer, mesa-helios and vkd3d-proton gets
its own `devenv.nix`/`nix/` entry points. Root adapters compose their outputs.
WinBoat, WBFreeRDP, Electron, CLVK and common packaging recipes stay here.
Build natively or cross-compile where ABI/SDK constraints permit; Windows MSVC/
WDK targets dispatch to the devbox. Never force a MinGW build where an MSVC ABI
library must link into the native Rust UMD. Preserve static CRT compatibility,
x64/x86 variants and paired protocol-generated headers.

An artifact manifest identifies component, source repo/commit/diff digest,
dependency commits, target ABI/architecture/configuration, toolchain identity,
files with SHA-256 and size, symbols, licenses and build/job provenance. Artifact
selection uses exact identities, never a latest-successful run. QEMU executable,
data files and dynamically loaded modules are one output from one build.

## Windows devbox

The devbox is QEMU in a pinned container with persistent local state. It uses
the **qemu-helios** output, never a runtime fallback to the distribution QEMU.
Start from the user's ISO with headless unattended installation, Enterprise
preferred, a deterministic `wbdev` account and `WB-DEVBOX` computer name,
generated local credentials/SSH keys, and the initial `virtio-vga-gl` device.
Persist autologin for `wbdev` using the Winlogon LSA secret and update its local
domain through hostname changes. Its generated local account password does not
expire. Verify the actual interactive login after reboots. The desktop login does
not own provisioning:
the elevated SYSTEM task survives disconnects, logouts and reboots.
The tracked provisioning lock owns exact tools/installers and hashes. Proprietary
media/installers remain external inputs with verifiable identity; Nix orchestrates
their use without promising byte-identical Windows disk images.

Provision VS Build Tools/MSVC, matched Windows SDK/WDK, required LLVM/libclang,
Rust/tool targets, OpenSSH, Git, PowerShell, Python/Meson/Ninja and graphics tools.
Enable test signing, provision the local test certificate, reboot and verify BCD
and a signed-driver load. Secure Boot policy must permit test mode. A provisioned
marker alone is insufficient. Persist phase/reboot state for unattended resume.

Expose this whole workspace to the guest at the defined share. Mirror only
selected sources into `C:\WinBoatDev\src`; build on local disk under
`C:\WinBoatDev\build`, with a local `CARGO_TARGET_DIR`. Use robocopy with exclusions,
known 0–7 success statuses, failure at 8+, snapshot identity and verified returned
artifacts. Guard `/MIR` against the wrong destination. Never compile on the share
or let a mirror operation delete build outputs or unrelated trees.

The headless VM remains independent of a viewer process. SDL is preferred for
on-demand interaction, with a demonstrated attach/close path. QEMU's local SDL
display normally shares its process lifetime; do not claim hot headless/SDL
switching without proof. Choose a separate attachable viewer/backend or document
the supported fallback and restart constraints in Stage 3. Discovery must work
with both Wayland and X11 without requiring either on a headless host.

Windows execution distinguishes `build`, `install`, `desktop` and `system`.
Desktop work uses the interactive user's session and refuses session 0.
Installation and long builds use durable elevated tasks. Transports encode
PowerShell safely and propagate real exit/reboot codes; uploads/downloads are
verified by hash at both ends. A local CLI invocation and its MCP equivalent
produce the same receipt.

## Strict installed-state registry

Track requested, built, staged, installed and observed-loaded identities
separately. Inventory covers provisioning tools, KMD SYS/INF/CAT/certificate,
UMD11/UMD12, x64/x86 variants, Mesa Vulkan/OpenGL ICDs, Khronos loaders, CLVK,
protocol pairing, host renderer and QEMU/modules. Each record includes source
commit/diff identity, artifact hash/version/architecture, install location,
package/device/store identity where applicable, operation ID, timestamp and
verification state. Host and guest observations remain distinguishable.

An install transaction checks compatibility, preserves the old state, stages
verified artifacts, executes the shared installer, handles resumable reboots,
and reconciles actual files/Driver Store/registry/loaded modules before success.
Unexpected files or hashes produce drift/unknown, never invented provenance.
Guest inventory is stored under `%ProgramData%\WinBoatDev\`; the host keeps
verified receipts in `.state/`. Desired manifests alone are not installed-state
evidence. A failed/partial install remains recoverable and cannot mark the whole
stack installed. Build IDs/hashes must identify loaded images rather than only
checking a filename or version string after its on-disk file was replaced.

## CI, installer and migration

Component repositories build and publish immutable, manifested artifacts using
their Nix entry points or a pinned Windows toolchain. The root release pipeline
downloads exact component artifacts and an already compiled installer, verifies
provenance/compatibility/hashes/licenses, assembles and publishes bundles.
**No component or installer compilation takes place in this repository's CI.**

Moving installer source here does not move compilation into root CI. A Helios
component build job checks out the selected root source commit to compile the
installer artifact, then publishes it with that source identity. Bundling runs
the prebuilt packer/installer assembly entry point. Tool/loader binaries also
arrive from designated component builds or verified upstream distributions.

Preserve the existing installer's unattended/reboot protocol and package format
through migration. Retire Helios's win-mcp, environment scripts and redundant
submodules only after the replacement builds/installs the same outputs and a
fresh-machine walkthrough passes. Component docs stay with components; migrated
environment/common docs live here. Preserve attribution and source history.
