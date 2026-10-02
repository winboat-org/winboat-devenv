# Component builds and artifact contracts

Run builds through the committed devenv shell. `wb build list` is the Nix-owned
catalog; CLI and MCP use the same source snapshots, recipes and receipts.

```sh
devenv shell -- wb build list --json
devenv shell -- wb build host-stack --plan --json
devenv shell -- wb build host-stack --background --json
devenv shell -- wb job status --id <job-id> --json
devenv shell -- wb build dxvk-win64 --background --json
devenv shell -- wb build verify --manifest out/native/<operation-id>/manifest.json
devenv shell -- wb build dxvk-engine-x64 --plan --json
```

Release mode requires clean sources at their declared pins, including the
selected shader/header gitlinks. `--mode development` captures tracked changes
and nonignored untracked files; each source gets a commit, diff digest, snapshot
digest and verified NAR hash. Conflicts, escaping source symlinks and concurrent
source changes are refused. Sources are exported under the operation's ignored
state directory; compilation never writes to a managed or reference checkout.
`--configuration debug|release` is separate from source mode. Shell entry and
plans do not clone any repository.

The six component repositories have their own genuine copied devenv lock,
standalone shell, `nix/default.nix` and `nix/standalone.nix`. Interface version 1
accepts explicit source snapshots, dependency outputs, target, configuration and
the locked toolchain. Nonempty toolchain overrides are rejected. Standalone
JSON specifications require `system`, `schemaVersion`, `target`, `configuration`,
`sources` (`repository: {path, narHash}`) and any required dependency output
paths. `devenv shell -- wb-component-build <specification.json>` works without
assuming a parent checkout location. Root adapters compose these interfaces.

| Target | Source/output and ABI |
| --- | --- |
| `host-stack`, `qemu-helios` | Exact QEMU fork, x86_64 system emulator, KVM/TCG, GL, SDL/VNC/egl-headless, matching modules/data/firmware |
| `venus-protocol` | One generator build produces paired driver and renderer headers; round-trip tests run |
| `virglrenderer` | Paired Venus renderer library and process render server; selected CPU regression tests run |
| `mesa-host` | Forked Linux Venus Vulkan ICD and Zink/softpipe OpenGL, with the same generated driver headers |
| `helios-protocol` | Linux Rust wire definitions and protocol tests; guest driver execution is separate |
| `dxvk-win64` | Standalone x64 MinGW DXGI/D3D9/D3D10core/D3D11 DLLs; GCC/C++/pthread runtimes link statically, Windows system `msvcrt.dll` remains an import |
| `WBFreeRDP` | Forked native client/library outputs, licenses and debug symbols |
| `dxvk-engine-x64/x86`, `vkd3d-engine-x64/x86` | Nix-evaluated guest dispatch plans for clang-cl/MSVC COFF engine archives with `/MT`; no MinGW substitution |
| `helios-guest-x64/x86` | Durable guest build plans; KMD is x64 only, UMD11/UMD12 have x64/x86 contracts |
| `mesa-guest-x64/x86` | Guest MinGW ICD plans, static C++ dependencies and explicit paired protocol input |
| `winboat`, `electron`, `clvk-helios` | Explicit adapter/input contracts; missing fixed dependency closures fail closed |

The engine archive names and compatibility headers follow the component's
current UMD link inputs. Guest plans retain LLVM 22.1.8, MSVC v143, matched
SDK/WDK 10.0.26100.0, bindgen 0.72 and Rust nightly-2026-07-14 requirements.
They specify the local `C:\WinBoatDev\src` mirror, `C:\WinBoatDev\build`, local
Cargo outputs and durable elevated `build` tasks. Execution fails with code 3
until Stage 4 supplies the backend. No guest install or loaded-state evidence
is produced by these plans. Meson/Ninja command templates use named tokens
for mirrored source/build/native-file paths; Stage 4 must bind them before
execution, rather than send host Nix paths directly to Windows.

QEMU requires keycodemapdb and Berkeley floating-point test wraps. Its recipe
supplies them from the locked Nix QEMU **source tarball**, compares wrap identities
to the fork, and supplies Vulkan headers from Nix. The emulator itself always
comes from qemu-helios. All QEMU gitlinks remain uninitialized. There is no
recursive bootstrap. DXVK's one nested SPIR-V header module is explicitly
declared and initialized at its parent's gitlink. Meson uses `nodownload`;
CMake adapter fetching is disconnected. Electron's DEPS, Chromium, depot_tools,
CIPD and sysroots require a complete verified closure; a Git pin does not provide
one. The WinBoat adapter additionally needs its Bun cache and exact forked
Electron/guest-server artifacts. CLVK requires its full compiler/LLVM/shader
translator closure. No floating dependency refresh is performed.

Artifacts use manifest schema 1 and distinct `out/native/` and `out/guest/`
operation directories. Each manifest records source/diff/NAR identities,
dependency revisions, Nix lock, complete derivation/toolchain inputs, shared
operation identity, ABI/configuration, file hashes/sizes, licenses, symbols,
ELF build IDs/RPATHs or PE imports/sections, and the immutable Nix closure.
Exports preserve store links and internal debug source-overlay references
rather than duplicating source trees. The operation's `result` retains a Nix GC root.
Moving only `files/` to a machine without that closure is insufficient; Stage 3
must import the selected closure into its container. Directory source links are
covered by the exported file table or closure's NAR hashes. `build verify`
checks the full exported file/link set and file content hashes. Manifests are
read-only and never replaced.

The `host-stack` includes a retained smoke report. It checks display enumeration,
virtio GL module loading from this build, the paired renderer's loader path,
and an SDL dummy-display QMP session. This establishes module/frontend integrity;
hardware Vulkan rendering and interactive SDL remain separate acceptance checks.
All build receipts report `built`, with installed/loaded state false.

Stage 2 commits are local. Ignored `workspace.remotes` overrides point to the
managed clones for exact local object verification; canonical URLs remain in the
tracked inventory. Canonical reachability of new commits is pending publication.
Publish children before the Helios parent and root pins using Stage 1's tools
only when authorized. Fresh contributors need published recipe commits or a
transfer of the local managed repositories, not merely this parent checkout.
