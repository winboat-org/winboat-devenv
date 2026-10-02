# Stage 2 — Nix component builds

Status: planned. Prerequisite: Stage 1. Windows-only output acceptance continues
in Stage 4 after the devbox is available.

## Outcome

The six Helios repositories own composable Nix/devenv build entry points. The
root control plane selects exact sources and produces manifested native/cross
outputs, including the complete QEMU fork used by the devbox.

## Implementation

Add `devenv.nix` and `nix/` recipes to helios, qemu-helios, dxvk, virglrenderer,
mesa-helios and vkd3d-proton. Define a versioned import/output interface accepting
explicit sources, dependencies, target, configuration and toolchain. Component
entry points must also work standalone; root orchestration must not bake in
relative paths to another contributor's checkout. Keep third-party/WinBoat/
WBFreeRDP/Electron/CLVK adapters here and share common interfaces without
duplicating component compiler flags.

Inventory actual binary/DLL targets and ABI constraints before choosing build
backends. Preserve the native static-CRT DXVK/vkd3d engines required by UMD11/
UMD12. Separate standalone MinGW DLLs from MSVC libraries and Windows WDK outputs.
Register Windows targets as explicit devbox-dispatched operations; unavailable
backends must fail clearly rather than yield a fake successful derivation.

| Component | Initial output contract to verify |
| --- | --- |
| helios | Linux protocol/helpers; Windows KMD package, UMD11/UMD12 and symbols, x64/x86 where supported |
| qemu-helios | x86_64 system emulator, all configured display modules, data/firmware references, container-consumable closure |
| virglrenderer + venus-protocol | Paired host renderer/server, protocol generators/headers and provenance |
| mesa-helios | Host requirements and Windows Venus Vulkan/Zink OpenGL ICDs, manifests, supported x64/x86 variants |
| dxvk | Native UMD engine libraries and supported standalone DLLs with ABI/CRT identity |
| vkd3d-proton + dxil-spirv | Native UMD12 engine, shader dependencies and supported standalone DLLs |
| Other root adapters | WinBoat app/guest server, WBFreeRDP, Electron source/build tooling, CLVK/compute outputs |

Build Venus generators once from its exact pin and feed consistent generated
headers into renderer/Mesa. Include dependency commits in every artifact record.
Use locked Meson/CMake/Ninja/Python/Rust/compiler tools and fixed source hashes.
Disable uncontrolled build-time network downloads; account for Meson wraps and
Electron's Chromium/depot_tools inputs explicitly. Validate QEMU's actual
required submodule paths; leave ROM/test repositories unfetched if Nix outputs
supply them or they are unnecessary. There must be no recursive QEMU bootstrap.

Build the QEMU executable and every configured dynamic module together; include
matching data and module search paths in its output. Enable the display/GL/Venus
features needed for headless launch and optional SDL transport. Never mix
modules from another build or rely on host-installed virglrenderer/firmware.

Expose targets through `wb build <component/target>` and the existing MCP proxy,
with `--json`, source/configuration preflight and immutable artifact manifests.
Keep native and guest output roots distinct. Development builds capture dirty
diff identity; release builds require declared clean source snapshots.

## Acceptance

Build the native QEMU/renderer/protocol closure in an isolated output prefix.
Run component tests and a QEMU module/display smoke, including the enabled SDL
backend where available; verify executable/module build identity and actual
loaded dependency paths. Confirm protocol-generated headers are coherent.

Cross-build at least a supported Windows user-mode output and inspect PE
architecture/import/CRT metadata. For ABI-constrained targets, demonstrate a
correct dispatch plan and mark runtime build verification pending Stage 4.
Validate individual per-repo shells/imports and root target selection without
cloning unselected repositories. Confirm manifests cover files, hashes, ABI,
toolchain/dependency identities, symbols and licenses.

Commit validated component recipe checkpoints, then update root pins to those
local commits. Do not claim remote reproducibility until those commits are
published and reachable through the authorized publication workflow. Pin
changes must remain separate from any unrelated reference checkout changes.
