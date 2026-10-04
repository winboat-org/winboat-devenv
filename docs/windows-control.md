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
Shared control scripts are published under a per-guest lock and reused only
after their complete hash/size table matches, avoiding concurrent sharing errors.
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

The controller binds the component Nix recipe tokens to those local paths, imports the
portable EWDK environment, selects LLVM and the matched kit, and runs its `/MT`
commands as a durable SYSTEM task. It returns hash/size-verified archives,
available PDBs, tool observations and license notices in manifest schema 1.
`build verify` checks the returned export. `--collect` resumes interrupted host
artifact collection from a succeeded guest build without compiling again.
Guest stdout reports source/prerequisite/dependency verification, execution,
artifact collection, export hashing and compression. PDBs inside a preserved
package directory return through its complete directory copy; other PDBs are
collected separately, avoiding a second copy over packaged symbols.

The [MSVC cross foundation](evidence/stage-04-msvc-cross.json) passed Linux
compilation/linking and Windows execution for x64 and x86 C++ executables using
the locked EWDK headers and static CRT. `nix/msvc-sysroot.nix` extracts those
inputs from the already verified provisioning payload; its header overlay and
library aliases accommodate Windows case-insensitive lookup on Linux. The
[cross dependency evidence](evidence/stage-04-cross.json) now records successful
DXVK/vkd3d/Mesa x64/x86 and CLVK cross builds, verified Windows imports and
CLVK/loader DLL loads. Component builds and lean composition passed; clean
pinned stack checks are next. Select devbox compilation only after documenting a
concrete cross-compilation blocker.

DXVK and vkd3d now use Linux MSVC cross builds by default. Linux WIDL is built
from the pinned mingw-w64 source and generates Windows headers on the host. vkd3d
enumerates seven required archives; its core archive already contains the full
shader dependency union, so there is no additional archive merge.

Helios's KMD and all four UMD variants, and Mesa's three ICD DLLs in both
architectures, passed native build acceptance. Their backends now allow clean
pinned release builds of the primary driver. Its current WDK build scripts
reject a Linux host, as detailed in [build usage](builds.md). Cross dependencies
and the package composer support clean pinned release builds; development mode
explicitly captures dirty source snapshots.
Nix supplies offline Cargo inputs from all three component
locks and CLVK's exact LLVM/header/loader sources. Linux generators and compiler
tools come from Nix; the primary Windows build gets its offline Cargo mirror.
File tables, derivations, hashes and licenses
remain in the artifact evidence. These extra build inputs do not change the
prepared Stage 3 provisioning lock. CLVK's LLVM/Clang dependencies use optimized
code without debug information; the recipe checks their actual compile commands
and requires zero compiler PDBs in `package/llvm-symbol-policy.json`. CLVK and
loader runtime symbols remain in their component artifacts.
Mesa's cross candidate uses the existing clang-cl
compatibility path with `/MT`, regenerates the paired Venus headers, and retains
them in its artifact. Full candidate acceptance remains pending.

`helios-development-package` assembles the existing script-driven development
bundle from Helios x64 (including its four UMDs), Mesa x64/x86 and CLVK/loaders.
Pass repeated `--dependency-manifest <artifact-manifest>` arguments to select
already verified builds explicitly; omitted dependencies build through the same
recipes. MCP exposes the equivalent `dependencyManifests` array. Selection checks
the guest identity, source revisions, configuration and required outputs, then
the shared guest wrapper verifies dependency trees and the bytes consumed by
the package. PDBs remain in their original component artifacts and are referenced
by manifest identity; packaging checks their tree/size metadata without copying
or rehashing them. The composer does not repeat the wrapper's content check.
The returned install manifest is
`files/bundle/manifest.json`. This development bundle preserves the legacy
installer contract; the prebuilt installer migration remains a later stage.

Artifacts return as one verified ZIP. Collection validates its complete member
table, sizes and file hashes before publishing each file. Corrupt partials stay
outside the final manifest tree. Older completed builds use a separate declared
export task; their original build receipts remain unchanged.

Windows source export materializes internal file/directory links while retaining
the original Git/NAR snapshot identity and a separate link table. Escaping links,
cycles and Windows path aliases fail before transfer. WinFlexBison runs with a
private temporary directory per invocation so concurrent generators cannot share
its fixed intermediate filenames.
Python generators disable bytecode writes through the declared utility input
and the shared build environment. An extra cache file still fails the complete
input-tree check; retries use a fresh utility closure instead of permitting or
removing unexpected files from a previously verified mirror.

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
devenv shell -- wb-windows-live --name <guest> --state-root <state-root> \
  --component-only --input-fixtures
devenv shell -- wb-windows-live --name <guest> --state-root <state-root> \
  --component-only --full-stack
```

The first checks CLI/MCP task purpose, cancellation/resume, script tampering,
real exit codes and fixture installation/drift/rollback. The second opts into
native x64/x86 DLL builds, actual mapped-code replacement/reload checks,
component build/manifest verification and a restart-required fixture. `--reboot`
restarts the named guest; omit it for checks that preserve its current boot.
Receipts remain under the selected state's `windows-acceptance/<id>` directory.
These checks neither create nor destroy a VM.
`--full-stack` builds the complete stack from clean pinned sources through CLI,
then builds it again through MCP, without reusing candidate artifacts. Each
repeat verifies the export, installs its exact manifest, resumes the original
transaction after required reboots, and checks 12 mapped DLLs, 13 interactive
graphics workloads and the actual resident kernel code. Source identities must
agree across the repeats; installed and loaded bytes must match each repeat's
own artifact manifest. This mode is implemented but full live acceptance is
still pending. It requires all selected native backends to pass their gates.
The input fixtures verify whole-tree hashes, missing/extra files, escaping paths
and junction refusal, then exercise snapshot extraction and resumed repair.

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
immutable source commits, signing identity and the four original installer
scripts beside `manifest.json`. It checks
every package file before staging or starting a task. The shared payload
preserves prior registry/legacy install snapshots and invokes that exact legacy
package installer as SYSTEM, retaining its unattended/reboot protocol. It does
not compile an installer or assemble a release bundle. Full-stack execution of
this path remains an acceptance gate.
The transaction journals original file existence as well as snapshot hashes.
Resume verifies retained backups and never treats state created by the first
installation attempt as a prior installation. The native recovery fixture
checks original bytes, original absence and changed-backup/path refusal.

`--fixture` accepts a manifest with `fixtureId` and a hashed `fixture.dll`, scoped
to `C:\WinBoatDev\fixtures\<fixtureId>` and its matching registry key. It supports
a one-time `--failure-after-copy` injection, explicit resume and `--rollback
<transaction-id>`, restoring the prior fixture file/registration. Helios rollback
requires its original package/restore protocol; the controller refuses to call
retained snapshots a complete rollback.
Fixture markers are data even though their contract names them `fixture.dll`;
reconciliation verifies their manifested hashes without claiming a PE image or
architecture. Actual stack binaries still require valid PE headers and the
expected architecture.

Registry reconciliation discovers provisioning, PnP/Driver Store, both Khronos
registry views, UMD/OpenGL registrations, x64/x86 loaders, certificates, runtime
files, fixture transactions and mapped process images. Unknown/manual images
retain unknown provenance. Expected file or registration mismatches report
drift. Host QEMU/renderer observations are recorded separately from the guest.
The latest package request remains separate from the observed installed package;
a failed or unfinished newer transaction cannot verify an older installation.
Protocol pairing compares the retained clean source snapshot and NAR identities.
Each reconciliation independently executes the 14 locked installed-tool probes;
cached provisioning success cannot hide a later tool update. The scoped
`Restore-PowerShell.ps1` operation verifies the prepared lock and original MSI,
preserves the previous package, and restores the selected version. Its MSI
options opt this product out of Microsoft Update without changing the machine's
global update configuration; see the [publisher's option definitions](https://learn.microsoft.com/en-us/powershell/scripting/install/microsoft-update-faq?view=powershell-7.6).
When the installed version already matches, it repairs the exact MSI's update
options if necessary. If repair retains the installed update component, it
reinstalls that preserved product with the selected MSI. Receipts retain the
product settings and global update service identities before and after;
an ineffective opt-out fails verification.

The mapped-image reader compares executable sections with the selected DLL,
normalizing PE base relocations. A replaced file can report `stale-mapped-image`
while its older code remains in a process. Unreadable images remain unknown.
This is executable-code evidence, not a hash of every mapped byte. Kernel loaded
image identity and complete selected-stack verification are still pending;
the baseline signing fixture's resident executable section has been measured
through the owned QEMU QMP socket. Kernel observation uses the native module
inventory's loaded base, reads resident executable sections, undoes relocations
and retains memory hashes. Discarded initialization sections are excluded and
unreadable resident sections remain unknown. Helios's full kernel gate remains
unmeasured; `registry verify` returns code 76 while any required evidence is missing.
Installation success and on-disk hashes never set `loadedVerified`.

`wb devbox smoke --name <guest> --transaction <install-id>` (MCP `devbox_smoke`)
dispatches the shared candidate graphics operation as the interactive user. It
separately verifies actual mapped DLL code in native/WoW64 processes and runs
Vulkan enumeration/WSI, Direct3D 11, OpenGL and Direct3D 12 device/clear workloads
for both architectures, plus x64 OpenCL compilation/execution. Probe results
retain exact program hashes, native exits, session, boot and transaction identity.
This operation still requires full native component/install acceptance.
Registry `show` returns its retained observation with its original timestamp;
`reconcile` and `verify` acquire new guest and host evidence.

Keep machine paths, credentials and the chosen guest/state root in ignored
`docs/user/`. The original development guest remains preserved; Stage 4 live
work uses a fresh named guest with the corrected host manifest/private NVIDIA
CDI path described in the handoff.
