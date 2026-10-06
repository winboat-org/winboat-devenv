# Validation

Stage 1 repository/MCP acceptance passed on 2026-10-02. Retained
[validation evidence](evidence/stage-01-validation.json) records the exact lock,
tool versions, configured MCP launch and live source inventory. The
[source evidence](evidence/stage-01-sources.json) separately records canonical
object/ref verification. All execution used the locked shell after bootstrap.

| Check | Result | What it establishes |
| --- | --- | --- |
| Genuine `devenv update` and shell evaluation | Passed | Fetched input hashes; CLI/modules share upstream revision `fe20b5cba7ab5e93ae73f956a8d3efc50e1753f4` |
| `devenv test` | Passed, 21 integration tests | Real local bare Git publication and Node MCP behavior; no GitHub pushes |
| Selection/sync fixtures | Passed | Single/all/subsets, dependencies, nested parents, exact gitlinks, selective third-party modules and paths containing spaces |
| Dirty/conflict protection | Passed | Working/index hashes preserved, unselected work retained, affected sync refused before source mutation |
| Scoped checkpoints and pin writers | Passed | Explicit paths/deletions, parent gitlinks, concurrent disjoint updates, unrelated root/index and same-file staged edits preserved |
| Git push wrapper | Passed | Delegation/global flags, successful/failed/dry-run/no-op/refspec/tag/delete cases, detached HEAD, lease and conservative ambiguity/pushurl handling |
| Post-push recovery | Passed | Injected pin-write and pin-commit failures retain remote success; reconciliation verifies the SHA without repushing; remote drift refused |
| Fork mode | Passed with local forks | Selected origin/upstream changes, missing-fork refusal, explicit fork source pins and unchanged global configuration |
| MCP fixtures | Passed | Initialize/list, typed failure, CLI parity, sync/fork/checkpoint, background disconnect and publication cancellation/retry refusal |
| Configured `devenv shell -- wb mcp` launch | Passed | 16 tools, JSON-RPC stdout, status identical to CLI; Claude config and Codex template use this launch |
| Live canonical source sync | Passed, 12 clean checkouts at exact pins | Includes DXIL-SPIRV/Venus and the resolved WBFreeRDP/Electron pins |
| Live submodule scope | Passed | All 16 declared QEMU submodules and LookingGlass remain uninitialized |
| Explicit shell entry | Passed | Managed/root HEAD, status and index hashes unchanged |
| Syntax/format checks | Passed | Node syntax, Bash shellcheck, Nix formatting and whitespace checks |

The locked shell uses devenv `2.4.1+fe20b5c`, Git `2.55.0`, Node `24.20.0`,
Python `3.14.7` and Nix `2.34.8`. The CLI and modules are unmodified upstream
sources. The earlier scaffold network and writable-Git blockers are resolved;
the imported scaffold history and unrelated external reference work are retained.

Native interactive activation is owned by devenv. At the maintainer's request,
the PTY activation harness and activation-specific regression tests were removed;
they are not part of `devenv test`. Nix, devenv and native auto-activation are
preconfigured prerequisites. An exploratory native Fish check exposed an unquoted
initialization path when the workspace contains spaces. No upstream patch is
retained. See [activation](auto-activation.md) for native hooks and explicit execution.
Interactive entry/exit behavior across all shells is not claimed as validated.

On 2026-10-05, removed `.envrc`, the direnv shell dependency and the obsolete
direnv doctor fields so native hooks own automatic activation. The updated
locked shell, `wb doctor --json`, checkout trust, Nix formatting and whitespace
checks passed.

The same follow-up assumes Nix, devenv and native auto-activation are already
configured. Removed hook setup/diagnostics, CLI/MCP activation options, shell
templates and the extra shell packages used by that setup. `wb setup` retains
workspace configuration/state preparation. The two existing setup and MCP
integration tests passed, along with Nix formatting and Node syntax checks.

Codex command refresh is now declared in `nix/codex.nix` and rendered by
`wb-codex-config`, using the same unchanged lock. The live integration check
on 2026-10-05 changed an imported Nix file, verified updated and removed
exports in new command shells, and verified identical PATH in nested shells.
Invalid Nix produced an explicit hook denial and preserved the last successful
environment. The original input was restored and refreshed afterward. Nix
configuration build/formatting, generated Bash syntax and Python syntax passed.
The generated local settings replace the earlier private cached-shell loader;
no host watcher service was installed. Existing Codex sessions require a restart
to load these settings; actual callbacks in this already-running session and
the rest of Stage 5 client/workflow acceptance are not claimed by this check.

The connected WinBoat MCP server's `repo_status` call also succeeded on
2026-10-05 with all twelve managed checkouts clean. Agent guidance now uses MCP
for routine workspace operations and CLI calls for explicit requests, CLI/shell
checks or operations without an MCP equivalent. This status call establishes
the current connection's repository inspection, not full Stage 5 acceptance.

Source reachability and clean synchronization establish a reproducible source
snapshot, not component/build/graphics compatibility. Stage 1 compiled no component,
provisioned no Windows guest, and attempted no organization push or GitHub fork
creation. Those remain outside Stage 1. The implementation stages and their
distinct acceptance scopes are recorded below.

## Stage 2 native/cross builds

The unchanged lock supplies six standalone component shells and shared root
operations. [Stage 2 evidence](evidence/stage-02-validation.json) records exact
local commits, manifests, source modes and retained checks. [Build usage](builds.md)
describes exports and guest dispatch.

| Check | Result | What it establishes |
| --- | --- | --- |
| Six standalone shells/interfaces | Passed | Own genuine lock, explicit hashed sources/dependencies, no assumed parent path |
| Native QEMU/renderer/protocol | Passed | Isolated fork output, 19 modules, 80 paired headers and immutable closure |
| QEMU unit suite | 105 passed, 3 expected skips | Native executables run; seccomp confinement, sandbox loopback and alternate AIO backend account for skips |
| Renderer CPU regressions | 5 passed | Queue synchronization, fault tracing/dispatch, string buffer and format-fuzzer checks |
| Venus protocol round-trip | Passed | Generator and paired wire headers from the exact protocol pin |
| Host smoke | Passed | Display enumeration, paired renderer loader identity, SDL/OpenGL module mappings and QMP using SDL dummy display |
| Mesa host | 46 tests passed | Forked Venus/Zink/softpipe output with paired protocol headers and symbols |
| Helios protocol | 14 tests passed | Rust wire library/source artifact with undeclared-license notice |
| WBFreeRDP | Build passed | Forked native binaries/libraries, source license and debug output |
| DXVK cross-build | 4 x64 DLLs passed | PE64, embedded DWARF, exact imports and static GCC/C++/pthread runtime dependencies |
| Guest/application plans | 11 evaluated | MSVC `/MT` engine contracts, x64/x86, local mirrors/tasks; unavailable execution fails with code 3 |
| Artifact verification | Passed | Complete file/link sets and hashes; tamper, extra files and escaping debug links refused |
| `devenv test` and MCP | 25 tests passed, 19 tools | Publication tests plus snapshots/checkout filters, selective plans, artifacts and typed build proxy behavior |
| Local checkpoints/pins | Passed | Explicit paths, matching gitlinks and local object verification; no GitHub publication |

Final evidence separates release builds at clean declared pins from earlier
development snapshots. Development failures/logs remain in ignored state,
including corrected sandbox exports, license paths, wraps, cross dependencies
and the initially skipped QEMU suite. Mesa's release export also exposed and
corrected handling of its declared CRLF checkout filter. Parsing alone was
never build validation.

Hardware Vulkan/render-server tests, interactive SDL, installed Windows outputs
and driver/DLL loaded-state acceptance remain pending. The CPU smoke starts no
installed guest. MSVC/WDK execution awaits Stage 4; WinBoat, Electron and CLVK
adapters refuse missing fixed dependency closures. Helios does not declare a
root/protocol license; its artifact retains attribution and a clarification
notice rather than inventing one.

All QEMU gitlinks and LookingGlass remain uninitialized. The only additional
shader fetch was DXVK's declared nested SPIR-V header gitlink. Six new recipe
commits and matching parent/pins are local-only; exact checks use ignored local
remote overrides. Canonical reachability remains pending publication. Component
CI, release bundles and guest installs were not attempted.


## Stage 3 devbox, current-host acceptance passed

The shared CLI/MCP lifecycle, Nix-built exact-closure image and Windows payloads
are implemented. [Stage 3 evidence](evidence/stage-03-validation.json) records
live identities and retained failures; [usage](devbox.md) describes the commands.
The finalized payloads passed unmodified blank-disk creation on this host, with
zero provisioning failures or repair uploads. The task resumed automatically
after identity and signing reboots and reached `verified` with all 14 tools.
The [runtime follow-up](evidence/stage-03-runtime-portability.json) adds private
NVIDIA CDI and a fresh rootless Podman/NVIDIA guest using corrected QEMU, plus
Docker's initial full Windows checks and actual alternate-UID preparation.
Another physical host and Windows boot under a second real host account remain
unvalidated. The corrected-artifact Docker repeat needs more daemon-store space.

| Check | Result | What it establishes |
| --- | --- | --- |
| Supplied ISO inspection | Passed | SHA-256 verified; actual WIM metadata selects amd64 en-US EnterpriseS LTSC 2024, image 1, build 26100 |
| Runtime/device discovery | Rootless Podman and Docker passed | Earlier Intel baseline plus NVIDIA private CDI; initial fresh Docker/Intel guest verified all 14 tools, autologin, signing, mirror/build return and viewer independence |
| Private NVIDIA CDI | Passed | Nix-pinned vendor generator, hooks and rootless Podman; fresh private spec on launch; injected files and six actual mapped NVIDIA libraries match hashes; system specs/hooks are excluded |
| Exact container closure | Passed | Image built/imported from the manifest-selected Stage 2 output; all 431 closure NAR identities checked, licenses/symbols retained |
| Actual host images | Passed | `/proc` executable plus seven renderer/GL module images match exact manifest paths/hashes; QMP works after reconnect |
| Initial Windows boot | Retained failure, corrected and retried | Non-secure firmware failed requirements; secure-capable firmware passed; a nonconsecutive partition modification order failed, then corrected fresh setup advanced automatically into installation; missing OOBE locale then exposed the region prompt, corrected fresh retry passed OOBE and reached wbdev desktop unattended |
| Guest identity/autologin | Passed after identity and signing reboots | Actual CIM name WB-DEVBOX; interactive wbdev session/explorer; LSA secret, no plaintext Winlogon password or count limit; account password does not expire |
| Guest network/SSH | Key authentication passed | Pinned guest host key, password authentication disabled; actual sshd executable/hash, durable inventory and SFTP artifact return observed on development |
| Separate viewer | Two attach/close cycles and long job passed | TigerVNC 1.16.2; same QEMU/container and SYSTEM guest-task PID survived; task completed tick 12 |
| Separate named state/ports | Passed with two concurrent VMs | Distinct container identities and four ports, both loaded fork QEMU instances; second guest retained an earlier partial tool lock and shut down cleanly |
| `devenv test` | Passed, 25 integration plus 17 devbox tests | CLI/MCP types/parity, runtime binding, private CDI, ownership/destroy refusal, relocated state, port collisions and creation resume preserving disk/keys |
| Windows payload parsing | Passed, seven PowerShell payloads | Also parses all 14 locked install/probe pairs; Linux parser validation only; not installed-tool, signing, mirror or Windows execution acceptance |
| Provision input lock | All 14 tools locked | Publisher files, complete SDK/WDK layouts, self-contained EWDK, dated Rust archives, cargo helpers and Vulkan core installer; these are not installed-version evidence |
| Installed tools | All 14 verified | SDK/WDK kit directories 10.0.26100.0 with separate QFE bundle identities, EWDK VS 17.14.5/MSVC 14.44.35207, dated Rust/targets/rust-src, remaining locked tools including Vulkan 1.4.350.0 |
| Test signing/driver load | Passed after actual reboot | Secure Boot false, HVCI services [0], effective BCD TESTSIGNING Yes, expected signing certificate and fixture hash, CIM driver Running with normalized NT path |
| Mirror/local build/return | Passed | Earlier seven-file fixture plus eight-file Docker/NVIDIA repeats; snapshot/diff identities, secret/output exclusions and unowned-destination refusal; local MSVC build/sign and matching SFTP SHA-256 |
| Interruption/recovery | Passed at copy/install/reboot boundaries | Identity/disk/SSH keys preserved through copy interruption; partial EWDK fails probe until full extraction marker; signing reboot resumes to verified baseline |
| Final blank-disk repeat | Passed | Owned test container/disk removed; development reached verified using finalized Nix payloads, zero failures/repair uploads, two automated reboots and post-signing wbdev desktop login |
| Live relocation/username | Passed within measured scope | Root with spaces, alternate USER/LOGNAME and explicit external roots controlled the same VM/SSH; actual kernel UID 1110 prepared/deleted isolated state with owned disk and 0600 keys; no second-account Windows boot or second host |
| EGL/GBM shutdown | Corrected release control passed | Old Intel Mesa teardown segfault reproduced without Windows under GDB; QEMU now releases EGL before destroying GBM; 105 unit tests pass with three documented skips, corrected Intel control exits normally, NVIDIA guest clean stop/restart passed |
| Corrected-artifact recreation | Podman/NVIDIA passed; Docker capacity-blocked | Owned test containers were destroyed before fresh creation; NVIDIA reached all 14 verified tools with two reboots; Docker image load exhausted daemon-store space and its prepared task state was removed |

The Docker follow-up used pinned client 29.8.0 against Engine 29.8.2 without sudo.
Runtime identity is now retained per guest, so Docker availability cannot orphan
an existing Podman VM. The initial Docker/Intel guest passed provisioning and
integration checks, then exposed an Intel Mesa shutdown crash. A diskless GDB
reproduction established the EGL/GBM cleanup order, which is corrected in local
QEMU commit `2544a0bb2b11992fe31d043961ed507fe581f31f` and its parent/pins.
The new clean release manifest is
`out/native/op-1c1559be28eb44628591806633633add/manifest.json`.

The user's selected NVIDIA path owns CDI through Nix-pinned rootless Podman.
Generator and hook GC roots, private YAML, input hashes and mapped-driver
observations are retained. Image import scratch follows the selected state
filesystem; an earlier `/var/tmp` exhaustion is retained. The corrected-artifact
Docker repeat still exhausted daemon image-load space after removing the unused
owned prior image. No host daemon storage configuration or unrelated state was
changed to force that check through. The existing `development` guest remains
stopped with its earlier artifact/disk retained; it has not been implicitly
migrated. Canonical publication of local component commits remains pending.
After the final restart, all tools and actual desktop autologin were checked
again. The test guest then shut down cleanly with a zero container exit and was
destroyed using its identity guard; its evidence and runtime cache are retained.

The [input evidence](evidence/stage-03-provision-inputs.json) and provisioning
lock record all 14 tools. Nix fetches every payload by its fixed SHA-256 before
building the image; Windows copies and rechecks the local cache before install.
Complete SDK/WDK external layouts were checked against their embedded publisher
hashes. The [EWDK ISO](evidence/stage-03-ewdk-input.json) supplies VS 2022/MSVC
and x86/x64 Spectre libraries with its complete license/layout. The
[Vulkan installer](evidence/stage-03-vulkan-input.json) matches LunarG's published
checksum and passed a Nix fetch with a standard Wget user agent. Only its offline
core is requested. Rust uses its dated distribution archives through a guest
loopback server; cargo helpers use pinned publisher binaries with licenses.

[Earlier acquisition evidence](evidence/stage-03-remaining-inputs.json) retains
the refused VS catalog hash mismatch and original LunarG HTTP 403 responses.
Those acquisition failures are resolved by the verified inputs above. A complete
input lock is separate from [observed installation and driver load](evidence/stage-03-windows-acceptance.json).

[Autologin](evidence/stage-03-autologin.json), [mirror/build](evidence/stage-03-mirror-build.json),
[copy recovery](evidence/stage-03-copy-resume.json), [install recovery](evidence/stage-03-install-resume.json),
[state sharing race](evidence/stage-03-state-race.json), [relocation](evidence/stage-03-relocation.json)
and [concurrent isolation](evidence/stage-03-isolation.json) retain measured receipts.
The [final recreation](evidence/stage-03-clean-e2e.json) records the bounded ACPI
shutdown timeout, forced stop and guarded deletion of only the task-owned guest.
That failure was preserved rather than reported as a clean shutdown. The earlier
copy-interruption guest and the second concurrent guest did shut down cleanly.
The first unmodified repeat exposed a stale SYSTEM-task `PATH`: the cargo helper
could not load Python's bundled C runtime. [The native reproduction](evidence/stage-03-native-path.json)
records loader exit -1073741515 and a passing version probe after refreshing the
machine path. The shared payload refreshes it before each next tool; the final
blank-disk guest passed first-install cargo helper probes with that correction.

Guest media, disks, credentials, payload snapshots, private machine settings and
failure logs remain ignored. Existing devboxes retain their prepared lock;
repository lock edits do not silently migrate a guest. Test devboxes and external
reference VMs were kept separate; only the explicitly recreated test guest's
generated disk was removed. No host package/group/daemon/bridge changes,
managed-source changes, component/installer CI, migration removals or pushes
were performed. [The Stage 4 handoff](handoffs/stage-04.md) records the measured
baseline and the remaining component-build and fresh-host limits.

## Stage 4 control checkpoint (historical)

[Stage 4 evidence](evidence/stage-04-control.json) records the fresh named guest
using the corrected host manifest and unchanged provisioning/Nix locks. Shared
CLI/MCP checks passed for an eight-minute SYSTEM task after client disconnect,
literal argument arrays, interactive wbdev execution and session-0 refusal,
native exit codes 42/3010, cancellation/resume, tampered-script refusal,
injected install failure/recovery, manual file/registration drift and rollback.
A restart-required fixture retained code 3010 across disconnect and resumed
only after an observed changed boot, then rolled back.

Clean-pinned DXVK x64 built through CLI and x86 through MCP. Returned manifests
verify all file hashes and retain licenses. The x86 build measured architecture,
static CRT and embedded CodeView symbols in all eight archives; its static
archives generated no separate PDB. The earlier x64 build predates those image
inspection fields. Independent native DLL/PDB fixtures built for x64 and x86;
actual loaded code matched, became stale after replacing the disk file, and
matched again after unloading/reloading in both process architectures.

The local suite passes 60 tests plus PowerShell parsing, mapped-image C#
compilation and literal argument binding. Live tests are opt-in and excluded
from ordinary CI. Earlier failures are retained, including an x86 shader tool
loading a 32-bit CRT into its 64-bit process and a receipt reader sharing race;
corrected runs passed. Clean full-stack build/install, kernel loaded-image
identity and interactive graphics smoke remain pending. Registry verification
returns code 76 for that incomplete gate. No stage approval or publication is
claimed; the original development VM and external source trees are preserved.

[The native checkpoint](evidence/stage-04-native.json) records clean-pinned
vkd3d x64 through CLI and x86 through MCP: seven static engine/shader archives,
native architecture and static CRT checks, generated headers, two PDBs and
15 license notices per architecture. The complete Helios candidate returned
its test-signed KMD SYS/INF/CAT, all four UMD DLLs, 176 PDBs and 481 license
notices. Matched Inf2Cat passed without errors or warnings, and all five native
images passed architecture/static CRT inspection. This development snapshot
predates the local recipe checkpoint; clean pinned repeats are still required.
Mesa x64 and x86 each returned the Venus, Zink WGL and OpenGL frontend DLLs,
five PDBs, 40 generated protocol files and retained license notices. All six
DLLs passed architecture/static CRT inspection. Initial collection refused an
empty .NET ZIP directory entry; the corrected collector verified the original
archives without recompiling. These are development snapshots, with compiler
and linker warnings retained; installed/loaded graphics proof is pending.
Native UMD x86 returned both DLLs, fresh
bindgen output and 56 PDBs, using a recorded development snapshot. Existing
compiler and stale cached-binding warnings were retained; fresh native layout
assertions remained enabled. The baseline signing fixture's kernel `.text`
bytes matched its SYS through the VM's QMP memory reader. This kernel proof
concerns that independent fixture; it does not establish Helios installation.
The Windows input fixtures also passed full-tree integrity checks, extraction
and resumed repair, extra-file/junction refusal and shared control publication.
Concurrent control jobs reuse verified scripts instead of reopening them while
another task reads them. Native candidate failures and retries remain retained.

[Creation capacity evidence](evidence/stage-04-capacity.json) records a fresh
512 GiB guest prepared through CLI and retried through MCP with its identity
preserved. Different existing capacities and invalid values were refused.
The earlier guest's disk and Windows recovery partition remain intact after
clean shutdown. The per-guest override leaves local defaults and both locks
unchanged. This guest subsequently passed all 14 installed-tool probes,
autologin and the signed fixture load after its signing reboot. PowerShell's
same-version MSI repair left update settings enabled and was refused by the
postcheck. A preserved-MSI reinstall verified the product opt-out, unchanged
executable hash and unchanged global update-service identities/flags. An MCP
repeat then left those settings intact without running MSI maintenance.
Full-stack build/install/loaded acceptance remains pending.

## Stage 4 full current-host acceptance

[Final evidence](evidence/stage-04-acceptance.json) supersedes the incomplete
Stage 4 gates recorded in the historical checkpoints above. Two complete stacks
built from the same clean pinned sources through CLI and MCP. Seven dependency
targets used Linux MSVC cross recipes; primary Helios used the documented native
WDK backend. All eight component artifacts retained complete file tables,
licenses, source/toolchain provenance and runtime symbols. LLVM/Clang's actual
compile commands contained no debug generation and no compiler PDBs were emitted.
Both 608-file install bundles contained zero PDBs.

Each exact package installed through a durable SYSTEM transaction, recovered
required reboots and received a final activation reboot. Each repeat passed all
13 interactive native/WoW64 graphics workloads: Vulkan enumeration and WSI,
Direct3D 11, OpenGL, Direct3D 12 device and clear in both architectures, plus x64
OpenCL compilation/execution. All 12 package DLL mappings matched executable
code, including private package loaders; each workload used verified app-local
loaders. Fresh registry verification independently checked all 14 locked tools,
installed package/Driver Store/registrations, paired protocol/host identities
and actual resident Helios kernel code. Both returned zero with installed and
loaded verification true. The retained source identities agree across repeats;
each repeat's installed and loaded identities match its own signed artifact.

[Runtime evidence](evidence/stage-04-runtime.json) retains the failures that led
to the EGL context restoration, same-INF package repair, activation reboot and
Win32 vehicle calling-convention fixes. The installer repair fixtures passed
under host PowerShell and native Windows PowerShell 5.1 as SYSTEM; the existing
33 hotplug cases also passed. Local validation passed 67 tests, PowerShell
parsing, mapped-image C# compilation and literal argument binding. The final
full live suite passed with both clean repeats; earlier failed receipts remain
retained. The genuine Nix/provisioning locks are unchanged and all managed
source checkpoints are clean and local. Nothing was pushed.

Acceptance covers the measured development environment on this host. It does
not establish driver conformance, screenshot/visual acceptance, another physical
host or second-account Windows boot. QMP's diagnostic screenshot returned
`no surface`. UMD12 warns that Linux cached bindings are stale; native builds
generate fresh locked-WDK bindings with layout assertions enabled. The original
development guest, old host images/closures, guest identities, keys/media and
external reference repositories remain preserved. WinBoat/Electron closures,
publication and later CI/installer/tooling migration retain their separate scope.

## Native Node control-plane rewrite (2026-10-06)

[Migration evidence](evidence/node-control-plane-migration.json) records the
replacement of the Python `wb` backend, detached workers, container supervisor,
Codex refresh and test runners with native Node.js modules. The CLI and all 45
typed MCP tools dispatch the same Nix-packaged operations. The genuine Nix and
Windows provisioning locks and all 12 managed source pins are unchanged. Exact
npm dependencies and integrity hashes come from `tools/package-lock.json` through
Nix `importNpmLock`. Compiler helpers and Windows PowerShell payloads remain
owned by the component/build recipes.

| Check | Result | Measured scope |
| --- | --- | --- |
| `wb-test` | 31 passed | Real local Git publication, concurrent receipts/pins, detached jobs, CLI/MCP parity, artifact identity/verification and command refresh |
| `wb-devbox-test` | 20 passed | Media, creation recovery, guest identity/disk preservation, runtime selection, CDI and shutdown boundaries |
| `wb-windows-test` | 20 passed | Durable control, literal arguments, native exit codes, installation recovery, kernel-memory identity and streaming archive integrity |
| `wb-windows-check` | Passed | 18 PowerShell payloads, mapped-image C# compilation, literal argument binding, JSON arrays and all locked install/probe payloads |
| Live Windows control through CLI and stdio MCP | Passed | Disconnected jobs, SYSTEM/interactive sessions, native 42/3010 exits, cancellation/resume, literal arguments, tamper refusal, fixture install/recovery and inventory drift |
| Live large requests and Windows input fixtures | Passed | Requests above 20 KiB, complete mirrors, snapshot inputs, verified transfer/extraction and repair |
| `wb build venus-protocol`, CLI/MCP verification | Passed | Real Nix component build; all 86 artifact files verified; source snapshot and NAR identities equal the retained Python-built artifact |
| Node supervisor Nix execution closure | Built | The actual closure selects Node 24.20.0 and the new `.mjs` entry point; replacement container boot remains untested |
| Generated Codex configuration | Passed | Private Node refresh hook and absolute Nix `wb` MCP launcher; other settings preserved; connected server observed running the Node CLI |
| Managed repository inspection | Passed | All 12 checkouts clean and exactly pinned after the live checks |

The live control run used a 12-second durability task. Eight-minute durability,
full stack rebuild/install/graphics acceptance, another host and second-account
boot were not repeated. Synthetic kernel-memory tests passed; this migration's
live registry fixture does not establish resident Helios code identity. Existing
Stage 4 evidence remains a historical acceptance record, and full Stage 5 client
workflows remain pending.

The existing guest retained its original container image, disk, credentials,
NVRAM and host artifact. Its old Python supervisor returned QEMU status `-11`
(container status `245`) during shutdown. The systemd core record confirms
SIGSEGV in Mesa Iris `util_vma_heap_free`, reached through EGL/display cleanup.
The Node CLI returned failure and preserved the stopped guest rather than
claiming clean shutdown. This is an unresolved runtime failure; the new Node
supervisor has not been substituted into that guest. The failed receipt and core
metadata are retained with the migration evidence.

The first live startup also caught a legacy manifest ordering incompatibility:
Python paths sort by components, while JavaScript full-path sorting differs for
names such as `firmware/a` and `firmware-old/a`. The corrected component walk
verified the original 1,118-file host manifest without rebuilding it; a regression
test covers ordering and escaped Unicode identity. A first Windows fixture run
against the stopped guest failed before the successful live repeats. The durable
runner now claims a queued job before opening its output; its regression check
verifies that refusing a duplicate runner preserves the completed result and
journal. All 31 integration/refresh tests passed again after that change. The
updated absolute MCP launcher was tested in a fresh client; an already running
Codex server retains its previous closure until reconnection. After the owner's
MCP restart, the connected process was confirmed running the final Node source,
including the receipt-preservation fix. Connected MCP calls verified all 12 clean,
pinned repositories and all 86 component artifact files. No component source
changes or pushes were made. Validation preceded the maintainer-requested
workspace commit.

## Nix formatting and refresh-state ownership (2026-10-06)

Codex export publication and the generated Bash handoff now use private
`.state/codex/` files. Project code obtains exports through the devenv CLI and
does not access its internal state directory. Existing internal state was left
untouched; there is no direct cleanup or migration operation. Ignore rules and
guest-share/mirror exclusions continue to prevent exposing private tool state.

Prettier 3.9.6 is supplied by the existing locked nixpkgs input. `wb-format` and
`wb-format-check` use that package, and formatting checks are included in the
Nix-declared test entry point. The existing MCP source was formatted to pass the
new repository check. No npm installation or lock update was required.

All 31 integration/refresh tests passed after these changes. The actual generated
hook and Bash handoff also passed a live check: `.state/codex/` had mode `0700`,
the published export had mode `0600`, and the command shell selected Prettier
3.9.6. Prettier, Nix formatting and whitespace checks passed. Reviewed project
Codex settings were merged while preserving other settings; restart Codex to
load the changed hook and Bash environment, and reconnect its MCP server for the
updated source closure. Full Stage 5 client/workflow acceptance remains pending.


## Stage 5 agent integration and live workflow (2026-10-06)

[Acceptance evidence](evidence/stage-05-acceptance.json) records the measured
current-host client/protocol, contributor-fixture and Windows runtime checks.
`wb setup --agents` merges project settings with private backups and preserved
approvals. SSH keys, host-key pinning and the derived config are automatic;
there is no additional SSH setup command. [Agent workflows](agents.md) document
client restart, explicit retry IDs, bounded host/guest waits and receipt pages.

The installed Codex CLI 0.160.0 app-server initialized both servers and called
repository, Nix and guest-status tools from a copied workspace path containing
spaces, without a model turn or policy changes. Claude Code 2.1.289 connected
both portable project servers through its actual diagnostics. Fresh generic
MCP initialization advertised 49 WinBoat tools and eight devenv tools. Generated
Bash refresh selected locked command wrappers and private mode-0600 exports.
Interactive client trust UI and Claude model-driven turns were not exercised;
Codex used explicit per-process generated server definitions for its test.

All 80 native checks passed: 37 workspace/agent/refresh, 21 devbox and 22 Windows.
The Nix test entry point, 19 PowerShell payloads, mapped-image C# compilation,
literal argument/array checks and compact inventory projection regression passed.
Formatting and whitespace passed. Local bare repositories tested scoped forks,
checkpoints, dependency-first publication and concurrent pins without organization
pushes. Two fresh MCP clients reused one durable mutation for one retry ID.
Queued launch recovery kept its original ID and preserved completed output.

The runtime workflow built fresh clean-pinned primary Helios with Linux MSVC
engine artifacts, composed a package with exact retained Mesa/CLVK artifacts,
installed it and resumed the original transaction after reboot. Thirteen
interactive workloads and all 12 mapped DLL identities passed. Inventory schema
2 then verified installed bytes, certificates, protocol pairing and actual
resident kernel code, including the fixture driver. The original development
guest and all 12 clean pinned repositories were preserved. Final normal shutdown
returned zero container exit and left the acceptance guest stopped.

The outer artifact manifest was initially refused by install preflight before
guest changes; the bundle manifest was used for the successful invocation.
Windows 3010 exposed the old host wrapper's Unix 194 presentation; current jobs
retain native codes separately and normalize historical observations without
rewriting original evidence. A 120-second shutdown deadline expired before the
normal shutdown completed cleanly. The proposed activation reboot failed before
submission when SSH closed; no forced reboot/stop executed. All failures remain
retained. Existing compiler warnings and the three baseline npm audit advisories
remain distinct from the passing checks; no unrelated dependency pins changed.

Full inventory exposed an 886,701,521-byte result caused mainly by repeating
artifact provenance in each file row. Schema 2 preserves that provenance once
and references complete transaction receipts, producing an 8,851,454-byte verified
record. The original oversized inventory and the helper strict-mode/publication
failures remain retained. Native unprefixed hexadecimal kernel pointers are now
validated without 64-bit precision loss, and unavailable observations remain
unknown. See [the handoff](handoffs/stage-05.md) for preservation boundaries.

The genuine Nix/provisioning locks and component pins are unchanged. The old
container supervisor was retained; this check does not prove its replacement's
fresh-container boot, another physical host, remote Windows host, conformance,
visual acceptance or canonical publication. WinBoat/Electron closures and
Stages 6–7 remain separate. Changes remain uncommitted and unpublished.
