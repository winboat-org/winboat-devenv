# Windows execution and inventory

Stage 4 is in progress. Its shared Windows controller is Nix-declared and the
Node MCP proxies the same `wb` operations. Complete Helios KMD/UMD/Mesa/CLVK and
loader build/install/loaded-state acceptance remains required. Keep the existing
win-mcp, installer and submodules available until those parity gates pass.

## Durable tasks and sessions

```sh
devenv shell -- wb devbox run --name <guest> --purpose build \
  --script tests/WindowsControlFixture.ps1 --json
devenv shell -- wb devbox job status --name <guest> --id <operation-id> --json
devenv shell -- wb devbox job cancel --name <guest> --id <operation-id> --json
devenv shell -- wb devbox job resume --name <guest> --id <operation-id> --json
```

`run` uploads the script and JSON request over the guest's pinned SSH/SFTP
connection, verifies SHA-256 and size, then registers a unique scheduled task.
The returned `queued`/`running` receipt is not completion. Closing the CLI or MCP
connection leaves the guest task running. Guest tasks use `devbox job`; host
orchestration jobs use `wb job`. Both retain their own identities and logs.

Build, install and system tasks require SYSTEM. Desktop tasks use the local
`wbdev` interactive logon; they require its Explorer session and refuse session
0 with code 87. `--direct` exercises that refusal or bounded diagnostics in the
SSH session; elevated work still requires SYSTEM. Guest operations encode
PowerShell as UTF-16LE and decode argument arrays from JSON inside the child.
Use `--argument=<value>` once per token, including tokens such as `-Seconds`.
MCP accepts an `arguments` array. Quotes and metacharacters remain data.

Receipts retain principal, session, boot time and the actual child exit code.
Codes 3010/1641 remain `reboot-required`, not success. Unix process exit codes
truncate large Windows codes; consumers must use the JSON `exitCode`. stdout and
stderr are separate durable logs; status returns at most 65,536 bytes per log.
Cancellation retains evidence. Resume verifies the original request, script and
inputs before retrying; it never selects another source identity.

## Sources and component builds

```sh
devenv shell -- wb devbox mirror --name <guest> --repo dxvk --repo helios \
  --mode release --background --json
devenv shell -- wb build dxvk-engine-x64 --name <guest> --background --json
devenv shell -- wb devbox build --name <guest> --target dxvk-engine-x86 \
  --background --json
devenv shell -- wb devbox build --name <guest> --collect <guest-build-id> --json
```

Mirrors export Git-owned contents under source locks. Release mode requires
clean declared pins; development mode records the diff. Revision, diff/snapshot
digest, NAR hash and selected shader/header gitlinks remain in evidence. Managed
dependencies retain their declared relative layout. Windows device names,
alternate streams, case collisions and escaping paths are refused.

The transferred archive has a complete file table. Windows verifies the archive
and every extracted file before publishing its mirror receipt. Each operation
has a unique `C:\WinBoatDev\src\<id>` destination; it cannot delete an earlier
mirror or a build tree. There is no compilation on the share. Build and Cargo
outputs stay under `C:\WinBoatDev\build\<id>`.

The controller binds DXVK's Nix recipe tokens to those local paths, imports the
portable EWDK environment, selects LLVM and the matched kit, and runs its `/MT`
commands as a durable SYSTEM task. It returns hash/size-verified archives,
available PDBs, tool observations and license notices in manifest schema 1.
`build verify` checks the returned export. `--collect` resumes interrupted host
artifact collection from a succeeded guest build without compiling again.

Other Windows component targets still refuse incomplete input/output contracts.
The Stage 3 toolchain does not supply all native `widl`, Python/Mesa MinGW,
shader, Rust dependency and CLVK compiler inputs needed by the full stack.
vkd3d's generic `shader-libraries` output description must become an exact file
contract. A dispatch plan or a fixture DLL cannot establish component acceptance.

The [retained acceptance evidence](evidence/stage-04-control.json) records real
clean-pinned DXVK x64 through CLI and x86 through MCP, with matching returned
file hashes. Both produced eight required static archives and 19 license
notices. The x86 build inspected every archive for I386 machine type, static CRT
and embedded CodeView symbols. No standalone PDB was generated; these symbols
remain inside the archives. The earlier x64 manifest predates that inspection
metadata and does not claim it.

Run the opt-in guest checks against an explicitly selected running guest:

```sh
devenv shell -- wb-windows-live --name <guest> --state-root <state-root> \
  --seconds 480
devenv shell -- wb-windows-live --name <guest> --state-root <state-root> \
  --component-only --native --build-target dxvk-engine-x86 --reboot
```

The first checks CLI/MCP task purpose, cancellation/resume, script tampering,
real exit codes and fixture installation/drift/rollback. The second opts into
native x64/x86 DLL builds, actual mapped-code replacement/reload checks,
component build/manifest verification and a restart-required fixture. `--reboot`
restarts the named guest; omit it for checks that preserve its current boot.
Receipts remain under the selected state's `windows-acceptance/<id>` directory.
These checks neither create nor destroy a VM.

## Installation and observations

```sh
devenv shell -- wb devbox install --name <guest> --manifest <package-manifest> \
  --background --json
devenv shell -- wb devbox install --name <guest> --resume <transaction-id> --json
devenv shell -- wb devbox registry reconcile --name <guest> --background --json
devenv shell -- wb devbox registry show --name <guest> --json
devenv shell -- wb devbox registry verify --name <guest> --json
```

Installation requires an exact complete x64/WoW64 Helios package manifest with
immutable source commits, signing identity and a manifested installer. It checks
every package file before staging or starting a task. The shared payload
preserves prior registry/legacy install snapshots and invokes that exact legacy
package installer as SYSTEM, retaining its unattended/reboot protocol. It does
not compile an installer or assemble a release bundle. Full-stack execution of
this path remains an acceptance gate.

`--fixture` accepts a manifest with `fixtureId` and a hashed `fixture.dll`, scoped
to `C:\WinBoatDev\fixtures\<fixtureId>` and its matching registry key. It supports
a one-time `--failure-after-copy` injection, explicit resume and `--rollback
<transaction-id>`, restoring the prior fixture file/registration. Helios rollback
requires its original package/restore protocol; the controller refuses to call
retained snapshots a complete rollback.

Registry reconciliation discovers provisioning, PnP/Driver Store, both Khronos
registry views, UMD/OpenGL registrations, x64/x86 loaders, certificates, runtime
files, fixture transactions and mapped process images. Unknown/manual images
retain unknown provenance. Expected file or registration mismatches report
drift. Host QEMU/renderer observations are recorded separately from the guest.

The mapped-image reader compares executable sections with the selected DLL,
normalizing PE base relocations. A replaced file can report `stale-mapped-image`
while its older code remains in a process. Unreadable images remain unknown.
This is executable-code evidence, not a hash of every mapped byte. Kernel loaded
image identity and complete selected-stack verification are still pending;
`registry verify` returns code 76 until that gate is implemented and measured.
Installation success and on-disk hashes never set `loadedVerified`.

Keep machine paths, credentials and the chosen guest/state root in ignored
`docs/user/`. The original development guest remains preserved; Stage 4 live
work uses a fresh named guest with the corrected host manifest/private NVIDIA
CDI path described in the handoff.
