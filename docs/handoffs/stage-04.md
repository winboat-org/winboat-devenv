# Stage 4 handoff

Stage 4 is accepted on the current host. The final clean-pinned CLI and MCP
repeats each built and installed the complete selected stack, passed all 13
interactive graphics workloads, matched all 12 mapped DLLs and verified actual
resident Helios kernel code. Both observed inventories matched their own bundle
manifests. See [acceptance evidence](../evidence/stage-04-acceptance.json),
[Windows control](../windows-control.md) and [validation](../validation.md).

Build policy follows the original scaffold instruction: cross-compile Windows
dependencies wherever possible and select a devbox build only for a documented
limitation. Seven targets now build on Linux with the MSVC ABI and static CRT:
DXVK, vkd3d and Mesa x64/x86, plus CLVK/loaders/probes. LLVM/Clang generate no debug
symbols. Runtime symbols remain in component artifacts; both 608-file install
bundles contain zero PDBs. The primary driver still requires Windows because
pinned windows-drivers-rs build scripts reject Linux hosts and UMD12's Linux path
does not link a DLL. [Build usage](../builds.md) records the exact blockers.

The accepted source set is Helios `0f2ff4a5fe047d59cca68d3bd1603d1b082f25dc`,
Mesa `59cfd87f49b3f65b382a86af33a7efbb2bd24789`,
DXVK `e73ee9d0da9628e5f444b2e002e0079fd96ae3d3`,
vkd3d `aff0927cab46c700a6edd78a3b1621fa9e109f18`, and
CLVK `56c626132782bf083a80a6c17f5ca763be0ff8fb`.
Host QEMU is `e81b51e1188a39e7041c4e06117b6bdf45becdd1`; renderer and paired
Venus identities remain recorded in the retained host manifest below.
All these checkpoints remain local/unpublished. No push was authorized.

[Runtime evidence](../evidence/stage-04-runtime.json) retains the original QEMU
EGL fallback crash and corrected isolated-overlay boot/shutdown, actual same-INF
driver-package export/removal/reboot recovery, OpenGL activation reboot, and the
symbolized Win32 WSI failure corrected by WINAPI function-pointer declarations.
The acceptance guest explicitly upgraded its host artifact with its old image,
closure and guest identity retained. The original development guest remains
on its original artifact. Large artifacts moved to selected local storage only
after complete type/mode/link/hash verification; portable `out/` paths remain.

The final graphics runs establish this development environment's measured
workloads, not driver conformance. QMP's diagnostic screenshot reported
`no surface`; visual acceptance is not claimed. Native UMD12 emits a stale Linux
cached-binding warning but generates fresh locked-WDK bindings with layout
assertions enabled. Another physical host, second-account Windows boot, the
corrected Docker repeat, canonical publication and WinBoat/Electron dependency
closure completion retain their previous limits. Stages 5–7 remain planned;
do not remove the old installer, win-mcp or submodules as part of this checkpoint.
Personal guest/state choices and retained operation logs are in ignored local
notes. The genuine Nix and provisioning locks remain unchanged.

## Retained Stage 3 baseline and original task

The text below records the original continuation contract and earlier baseline.
Its Stage 4 build/runtime requirements are now satisfied by the acceptance
evidence above; its preservation and publication boundaries still apply.

The current-host Windows baseline passed all 14 installed-tool probes, the
signing reboot/driver load, autologin, local mirror/build/hash return and recovery
checks. The final unmodified blank-disk repeat passed with zero failures or
repair uploads; consult [validation](../validation.md) and
[recreation evidence](../evidence/stage-03-clean-e2e.json)
for retained identities and limits. This baseline establishes a
development guest; Helios component installation/loaded-state acceptance belongs
to Stage 4.

The [runtime follow-up](../evidence/stage-03-runtime-portability.json) records
Docker's initial full Windows checks, a fresh private-CDI Podman/NVIDIA baseline,
alternate kernel UID 1110 preparation/deletion and the QEMU EGL/GBM shutdown fix.
The user selected Nix-pinned rootless Podman with private CDI and no system CDI
setup. The corrected-artifact Docker repeat is blocked by daemon image-load
space; another physical host and second-account Windows boot remain pending.
The original `development` guest is stopped and retained with its earlier
artifact; it has not been migrated to the corrected host output. The fresh
follow-up test guest was cleanly stopped and destroyed after acceptance.

```text
Implement docs/stages/04-windows-control.md using the verified Stage 3 baseline.
Read AGENTS.md, README.md, architecture/repositories/workspace/
builds/devbox docs, validation, config/provision.lock.json and the Stage 3/4 specs.
Inventory root and all managed/nested Git status before edits and commits.
Preserve unrelated changes, external reference repositories, existing VMs, media
and keys. Use the unchanged genuine devenv.lock and locked shell. Do not refresh
inputs, push, recursively initialize QEMU gitlinks, remove win-mcp/submodules or
compile installer/component binaries in root release CI.

Shared operations live in tools/wb/devbox.mjs and Nix-declared devbox.nix,
scripts/devbox-run.mjs and windows/*.ps1. Node is a typed command proxy for the
same wb application. Keep component build/install execution in shared
Nix-declared Windows payloads, with durable jobs/receipts and CLI/MCP parity.
Stage 2's Windows dispatch plans have not executed component builds yet.

NVIDIA launches generate private CDI with the locked vendor toolkit and Nix
hook, retain both GC roots and pass only the operation's private spec directory
to rootless Podman, with an empty Nix OCI hook directory. Do not install host
CDI packages, edit /etc/cdi, register a Docker NVIDIA runtime or handwrite specs.
Host KVM, user mappings, device permissions and matching kernel/userspace driver
remain external inputs. The launcher verifies injected hashes and actual mapped
NVIDIA images; this is host EGL startup, not Windows Helios/Vulkan acceptance.
Runtime bindings preserve the original store/daemon identity of each guest.
Podman import scratch follows the selected state filesystem; Docker's daemon
needs its own image-load/store capacity. Do not prune unrelated state to retry.

Use the current corrected clean release manifest explicitly:
out/native/op-65d4c969d69c4307b2d382bfc1655b84/manifest.json
SHA256 4c7a1d98775fb253026d536ab8bc575258c82e2fcbb655447489762e5887fb68
QEMU e81b51e1188a39e7041c4e06117b6bdf45becdd1;
Helios parent 5617cf5cdd7a548ea96f54e93c7163a57268d685.
These pins are local/unpublished. The preceding corrected artifact remains
retained under op-1c1559be28eb44628591806633633add, SHA256
e4eb6a4d99d70f1f1d3477168d4cee32ba6d47deb2c8ff9cefabbe4aa1f75cf1.
EGL resources must be released before GBM destruction. The old Intel artifact
segfaulted during shutdown; the corrected release's diskless Intel control exits
normally and 105 QEMU unit tests pass, with three documented skips. A clean
shutdown now requires an actual zero container exit, not just an SSH/ACPI ack.
Verified guests use authenticated SSH shutdown; timeout preserves a running VM.
The original development VM retains the old artifact. A new named guest remains
the default for a changed host stack. Explicit `wb devbox migrate-host` now
supports a stopped, owned guest's QEMU-only upgrade: it requires a clean release
manifest, unchanged renderer/protocol pairing, retained old image/closure and
successful image preparation before selecting the new artifact. It preserves
disk, NVRAM, TPM, keys and signing identity; startup must independently prove
loaded images. This path was used only for the task-owned acceptance guest.

The exact Stage 2 host-stack manifest/closure is retained, including QEMU,
renderer/server, seven GL module images, firmware/data, headers, symbols,
licenses and smoke evidence. Actual /proc paths/hashes were observed. Host
startup does not establish guest Vulkan or Helios acceptance. The native and
cross component recipe commits and parent/child pins remain local/unpublished;
canonical fresh-host source reachability is not established. No push is authorized.
Keep the Helios protocol license notice through any later migration.

The user-supplied ISO was verified as amd64 en-US EnterpriseS LTSC 2024, index 1,
build 26100, SHA-256 157d8365a517c40afeb3106fdd74d0836e1025debbc343f2080e1a8687607f51.
Its path and machine choices are ignored local configuration. The original
rootless Podman/Intel baseline is preserved, but its old QEMU artifact exposed
the shutdown crash described above. Create a new named guest with the corrected
manifest and discovered NVIDIA render node for Stage 4; do not silently migrate
the original development guest. Runtime bindings retain each guest's original
store/daemon identity even when current configuration changes.
Private CDI/NVIDIA full Windows acceptance and initial Docker/Intel acceptance
passed. The corrected Docker repeat remains capacity-blocked. Actual kernel
UID 1110 preparation/deletion passed in an isolated controller; second-account
Windows boot and another physical host are pending. Live relocated-root control
also used spaces, alternate USER/LOGNAME and explicit external overrides.
Discover current capabilities, including graphics userspace rather than only
node permissions. Private launches do not change system CDI or daemon setup.

All 14 tool inputs are locked and prefetched by Nix before image creation:
546 unique payloads, 22,891,136,712 bytes. Windows copies each execution input
to protected local disk and verifies its SHA-256. Full SDK/WDK external closures,
EWDK, dated Rust archives/targets/rust-src, cargo helpers/licenses and Vulkan
core are offline inputs. Installed versions were observed separately from pins.
VS Build Tools is the complete portable EWDK 17.14.5, MSVC default 14.44.35207,
compiler file 19.44.35209.0, with x86/x64 Spectre libraries and license/layout.
Use WINBOAT_EWDK_ROOT/WINBOAT_VS_ROOT and BuildEnv/SetupBuildEnv.cmd; do not assume
vswhere registration. SDK/WDK kit directories are both 10.0.26100.0; bundle
versions 10.1.26100.6901 and 10.1.26100.6584 are separate recorded identities.
Rust is nightly-2026-07-14 with x64/x86 MSVC targets and rust-src; Vulkan is
1.4.350.0 offline core. The strict lock/inventory has the remaining versions.
The original VS catalog mismatch and LunarG 403 were refused and retained;
verified EWDK/publisher inputs resolved acquisition without fabricated hashes.

Creation journals ownership before side effects, preserves disk/NVRAM/TPM/keys
on retry and pins the generated guest SSH host key. Guest defaults are wbdev,
WB-DEVBOX, Z:\, C:\WinBoatDev\src and C:\WinBoatDev\build. Secrets/answer media
stay private and ignored. Autologin uses Winlogon's LSA secret, has no plaintext
Winlogon password or count limit, keeps the local account password nonexpiring
and updates its domain through identity renames. Actual interactive desktop
user/explorer was observed after reboots. The SYSTEM task owns provisioning
independently of that login. Hybrid shutdown is disabled for full startup resume.

EWDK extraction writes its ISO-hash completion marker atomically after the full
copy; a partial compiler tree fails verification. Cache-copy and active EWDK
extraction interruptions resumed without changing identity/keys. Provision state
uses atomic File.Replace with bounded sharing retries; an exact Windows reader
collision reproduced the old failure and verified the replacement. Native
stdout/stderr and earlier failures are retained. Installers change Machine PATH
without updating the running SYSTEM process; provisioning refreshes that path
before each next tool. The native reproduction proved the cargo helper's missing
CRT failure and resolution using the runtime bundled with locked Python.
Rust's HTTP distro uses guest loopback only, records original/relocated manifest
hashes and uses the verified
portable compiler. Cargo helper argument arrays handle Windows PowerShell 5.1.

The exact workspace UNC is authenticated in each mirror caller's logon session.
SYSTEM's visible Z: link may lack SSH-session credentials after reboot.
Samba and Mirror.ps1 exclude secrets, state/Git metadata, outputs and junctions;
mirror destinations require ownership and bounded robocopy status checks.
Snapshot/diff and every mirrored file hash are retained. BuildFixture.ps1 built
and signed the independent driver from the local mirror using matched KM/shared/
UCRT headers, then SFTP returned an identical hash. Its output and Cargo target
roots are on C:, never the share. Effective BCD TESTSIGNING Yes after a changed
boot, Secure Boot false, HVCI services [0], expected certificate and CIM driver
Running were observed. CIM's NT path prefix is normalized and the native path
is retained. This fixture is separate from Helios KMD/UMD/ICD loaded-state proof.

TigerVNC is the attachable fallback. Two open/close cycles preserved the same
QEMU/container and long SYSTEM task PID through complete tick 12. No separate
SDL client was available; QEMU-local SDL hot attach is not promised. Two live
headless devboxes passed state/four-port isolation (the second used an earlier
partial lock and shut down cleanly). Some ACPI shutdowns timed out and preserved
the VM; explicitly forced stops were recorded as unclean. A guarded task-owned
guest destruction preceded final blank-disk creation. Inspect current named
state rather than relying on historical test names. Existing devboxes retain
prepared payload/lock snapshots; use a new name for a changed lock until a
verified explicit migration exists. Never overwrite an unrelated guest disk.

Stage 4 must implement component source mirrors/CARGO_TARGET_DIR, Nix payload
dispatch, durable elevated build/install tasks, interactive desktop-purpose/
session checks, safe PowerShell encoding and hash-verified upload/download.
Keep desired, built, staged, installed and actually loaded KMD/UMD/ICD/host
identities distinct. Observe loaded images, Driver Store, registry and reboot
state before reporting success. A copy or reboot does not prove a loaded version.
Complete Stage 4 acceptance and devenv test, update docs/status/evidence and
commit scoped validated checkpoints without publication.
```
