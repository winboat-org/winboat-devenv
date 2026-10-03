# Stage 4 handoff

The current-host Windows baseline passed all 14 installed-tool probes, the
signing reboot/driver load, autologin, local mirror/build/hash return and recovery
checks. The final unmodified blank-disk repeat passed with zero failures or
repair uploads; consult [validation](../validation.md) and
[recreation evidence](../evidence/stage-03-clean-e2e.json)
for retained identities and limits. This baseline establishes a
development guest; Helios component installation/loaded-state acceptance belongs
to Stage 4.

```text
Implement docs/stages/04-windows-control.md using the verified Stage 3 baseline.
Read AGENTS.md, README.md, architecture/repositories/workspace/
builds/devbox docs, validation, config/provision.lock.json and the Stage 3/4 specs.
Inventory root and all managed/nested Git status before edits and commits.
Preserve unrelated changes, external reference repositories, existing VMs, media
and keys. Use the unchanged genuine devenv.lock and locked shell. Do not refresh
inputs, push, recursively initialize QEMU gitlinks, remove win-mcp/submodules or
compile installer/component binaries in root release CI.

Shared operations live in tools/wb/devbox.py and Nix-declared devbox.nix,
scripts/devbox-run.py and windows/*.ps1. Node is a typed command proxy for the
same wb application. Keep component build/install execution in shared
Nix-declared Windows payloads, with durable jobs/receipts and CLI/MCP parity.
Stage 2's Windows dispatch plans have not executed component builds yet.

The exact Stage 2 host-stack manifest/closure is retained, including QEMU,
renderer/server, seven GL module images, firmware/data, headers, symbols,
licenses and smoke evidence. Actual /proc paths/hashes were observed. Host
startup does not establish guest Vulkan or Helios acceptance. The native and
cross component recipe commits and parent/child pins remain local/unpublished;
canonical fresh-host source reachability is not established. No push is authorized.
Keep the Helios protocol license notice through any later migration.

The user-supplied ISO was verified as amd64 en-US EnterpriseS LTSC 2024, index 1,
build 26100, SHA-256 157d8365a517c40afeb3106fdd74d0836e1025debbc343f2080e1a8687607f51.
Its path and machine choices are ignored local configuration. Rootless Podman
with workspace-local VFS storage and Intel Mesa EGL worked. Docker socket access
failed; no host groups, packages, daemon, bridges or desktop config changed.
Discover current capabilities, including graphics userspace rather than only
node permissions. Proprietary GPU/CDI, another OS UID and another host remain
unvalidated. Live relocated-root control used spaces, alternate USER/LOGNAME
and explicit external state/source/output overrides with the same OS UID.

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
