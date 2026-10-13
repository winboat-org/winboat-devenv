# Exact component artifacts and release candidates

Stage 6 supplies repository-owned component workflows and a shared verifier and
packer. All 13 exact inputs, local candidate assembly and hosted assembly passed.
Fresh installer runtime acceptance remains in progress. The measured gates and
artifact identities are recorded in [Stage 6 evidence](evidence/stage-06-implementation.json).

The root remote is `https://github.com/winboat-org/winboat-devenv`. The user
authorized source checkpoints, dependency-first pushes and hosted CI runs.
Component artifacts retain their explicit build-root identities: `99b509d`
for QEMU/installer/ADL/catalog/CLVK, `833227b` for refreshed DXVK/Mesa,
`ce49636` for the driver, and `6797be4` for unchanged vkd3d/renderer inputs.
All source pairings and consumed engine-manifest receipts verified. QEMU's
component archive is 142.5 MB, 87% smaller after removing the duplicated full
host closure and redundant source aliases while retaining modules and symbols.

Root hosted run
[`38353599147`](https://github.com/winboat-org/winboat-devenv/actions/runs/38353599147)
passed verification, Windows prebuilt packing and final verification. It uses
assembly source `5024969307a6a29395a7d86904eb7d678b9dbf48` and reviewed
input data from `bb8f1c467dc7b9759c0582230760f2b2a6c12031` at
[docs/release-inputs/winboat-release-inputs-20261013.json](release-inputs/winboat-release-inputs-20261013.json),
SHA256 `9d1944b2eb7a7d7421b465f8b65289871e3d6eb550811c7310953031ba87765c`.
Local and hosted payload digest is
`d81ce5cdb9f9f138b90f55d131ad6bf42d2b3217f9eb1fa596187d1d3b454317`.
Both produced a byte-identical 38,633,082-byte installer, SHA256
`6e0c815d3f3432e039b8ac7f03d6a460edb7144c029f4ab9981dc7d6f6359170`.
All 734 final hosted artifact members verified. Root logs contain no component
or installer compilation. The 1.36 GB candidate evidence archive preserves the
13 original component/symbol archives and unpacked payload; the distributable
installer itself is 38.6 MB.

Local packing corrections verify the CMS signature, pinned certificate bytes,
validity and code-signing usage, then catalog membership with the existing
prebuilt verifier. Download verification compares hash/size while preserving
path guards and checks before and after transfer. The 126-check suite passed.
Historical failures and rejected input cohorts remain in the evidence.

The fresh acceptance guest verified all 14 tools and its signed fixture driver.
It then disabled test signing to exercise the installer's own gate. The exact
candidate returned native 3010 with `test-signing-restart-required`; after reboot,
automatic provisioning installed the package and returned 3010 with
`driver-restart-required`. The next boot reached `finished` and removed the
startup task. Registry/loaded-code verification, interactive graphics and
repair/update/uninstall acceptance remain in progress.
The prior development guest and all retained artifacts remain preserved.

Root release CI uses public hosted runners. Driver production uses hosted Ubuntu
preparation, Windows compilation/signing and Ubuntu artifact verification. The
installer cross-compiles on hosted Ubuntu and has a separate Windows interface
probe. Root CI consumes those already built artifacts. No release was published.

## Production ownership

Each workflow owns one build responsibility. Architecture matrices stay within
that component. The common execution template is
[ci/component-build.yml.in](../ci/component-build.yml.in); workflow paths in
artifact provenance come from GitHub's actual workflow identity.

| Repository    | Workflow                      | Responsibility                       |
| ------------- | ----------------------------- | ------------------------------------ |
| helios        | `build-helios-drivers.yml`    | Signed KMD and native/WoW64 UMDs     |
| helios        | `build-helios-installer.yml`  | Migrated installer and packer        |
| helios        | `build-adl-compatibility.yml` | ADL compatibility shim               |
| helios        | `build-catalog-verifier.yml`  | Prebuilt catalog membership verifier |
| helios        | `build-clvk-runtime.yml`      | CLVK runtime, loaders and probes     |
| qemu-helios   | `build-qemu.yml`              | QEMU executable, modules and symbols |
| virglrenderer | `build-virglrenderer.yml`     | Renderer and paired Venus headers    |
| mesa-helios   | `build-icds.yml`              | Native and WoW64 Mesa ICDs           |
| dxvk          | `build-dxvk.yml`              | Native and WoW64 DXVK engines        |
| vkd3d-proton  | `build-vkd3d-proton.yml`      | Native and WoW64 vkd3d engines       |

Manual dispatch selects exact root/component commits and release/debug output.
Cross jobs use hosted Ubuntu and only their component command and source closure.
The primary driver retains its Windows WDK build requirement, fulfilled by a
hosted Windows job with portable Nix-verified inputs. The installer
build uses the same cross SDK and pinned Rust distribution, followed by a
Windows job that probes the already built executable. No generic workflow
builds unrelated component roles in one matrix.

Linux cross compilation supplies DXVK, vkd3d, Mesa, CLVK/loaders/probes and the
compatibility shim and catalog verifier. The separate
[ADL recipe](../nix/build-adl-compatibility.nix) and
[catalog verifier recipe](../nix/build-catalog-verifier.nix) share only the
[locked Windows toolchain setup](../nix/windows-release-tool.nix).
Helios retains the documented Windows WDK build-script
blocker. The migrated installer supports an explicitly selected resource compiler and
portable resource paths. Its Nix recipe uses LLVM resource tools and the pinned
nightly Rust host compiler/Windows standard library from the verified publisher
manifest. Cargo dependencies remain vendored from the unchanged installer lock,
with a local `CARGO_TARGET_DIR`, static CRT and retained PDBs. Its local cross
build and hosted Windows interface check passed.

The Helios driver job requires four exact artifacts from the DXVK/vkd3d jobs,
using JSON selectors with `repository`, `artifactId`, `runId`, and `runAttempt`.
It imports and verifies their original build manifests, configuration and source
identities. Missing engines fail before driver compilation; no dependency-build
fallback is used. CLVK's designated Helios job uses the existing Linux recipe and
retains its fixed Khronos/LLVM revision table and no-compiler-symbol policy report.

## Composed CI environments

[nix/ci.nix](../nix/ci.nix) defines separate release, workflow lint, source sync,
component and Windows-component packages. [nix/ci-environment.nix](../nix/ci-environment.nix)
imports that base into the development environment; development adds its devbox,
agent and editing tools. The same locked packages and shared Node operations are
used in both paths. CI realizes one package, not the complete development shell:

```sh
nix build --no-link --print-out-paths --file nix/ci.nix release
nix build --no-link --print-out-paths --file nix/ci.nix component
```

Workflow syntax checking runs locally through `wb-workflow-check`, including
the local validation task. There is no hosted workflow-lint job.

Measured release command closure is about 630 MB, workflow lint 247 MB,
compared with 2.64 GB for the development controller. These are runtime NAR
closure sizes, not cold-build download, build-output, artifact or peak RSS
measurements. Component compilation still needs its selected SDK/build inputs;
it does not realize those inputs in the root release jobs. Use immutable Nix
binary caches for expensive toolchain outputs rather than caching the complete
store, guest state or a development shell. This follows the
[Nix CI guidance on binary caches](https://nix.dev/guides/recipes/continuous-integration-github-actions.html).
[devenv profiles](https://devenv.sh/profiles/) add configuration to a base;
using a full development base would still bring its packages into CI. The base
here supplies the CI commands, and development imports it before adding tools.

The SDK provenance records its locked ISO name and digest without retaining the
ISO store path in the output closure. Local verifier output closure measurement
fell from 26.5 GB to 3.62 GB with both x64 tool recipes rebuilt successfully.
Cold cross-builds now use the fixed-output SDK subset in
[msvc-sdk.lock.json](../nix/msvc-sdk.lock.json). Its file hashes, byte extents and
NAR hash were generated from the complete SHA256-verified locked EWDK image.
The downloader reads only the selected ranges, verifies every member and the
complete output NAR, and retains the SDK/CRT libraries, headers and licenses.
Local-media and remote HTTP extraction produced the same hash: 7,239 files,
about 2.00 GB of content and 2.01 GB of range reads from the 20.00 GB image.
Memory for concurrent range bodies is bounded at 32 MiB. Full Windows guest
provisioning still uses its original locked media; no input lock was replaced.

Component source sync selects that component's dependency closure. Root-only
installer/shim/verifier builds do not clone the graphics stack. The driver preparation selects only native MSVC compiler/include/static-library
files from verified EWDK extents and the required SDK/WDK MSI/cabinet packages.
Portable LLVM and Rust come from the locked payloads. It needs no prepared guest
or registered runner. The Windows job generates its own ephemeral test-signing
certificate and emits signed artifacts; it does not install the driver. Private
state, keys and media remain outside source caches and artifacts.

## Source migration

[migration/helios-installer-source.json](../migration/helios-installer-source.json)
attributes 41 copied files to Helios commit
`0f2ff4a5fe047d59cca68d3bd1603d1b082f25dc`, with Git blob IDs and file hashes.
The accompanying `helios-installer-history.fi` retains the locally available
path history after the recorded `52c02799...` boundary. It can be imported into
an empty temporary Git repository using `git fast-import`; it is not a claim
that unavailable earlier history was recovered. Originals remain in Helios.

`installer/`, `packaging/windows/`, metadata and shared build helpers live here.
The installer continues to run the shared PowerShell install/uninstall payload;
CLI/MCP installation runs that same payload from the verified bundle. The
`HLIOSET2` container and silent/automatic/reboot/status/registry snapshot contracts
remain intact. `--packer-info <json-file>` declares interface version 1 without
requiring console output from the GUI executable. Root assembly probes this
interface before running `--bundle <payloadDir> <outputExe>`.

Runtime PDBs and licenses remain in their exact component artifacts. License
notices and source attribution are retained as supplied; migration does not
choose or change an upstream license. Install payloads contain zero PDBs.

## Immutable inputs

The three schemas are deliberately distinct: original build manifest schema 1,
`winboat-component-artifact` schema 1, and `winboat-release-input` schema 2.
Release-input schema 1 is rejected; regenerate the input from the thirteen
separately produced variants, including the catalog verifier.
Normalization retains the original build manifest and explicitly verifies its
file table, clean source identities, toolchain digest and recipe revision.
The resulting install manifest retains the existing package schema 1, with
compact component/source references for strict protocol and loaded-state checks.

Release inputs include the exact root source revision and lock hash, source
files used by the installer/payload, component/dependency pins, workflow path/run
attempt/SHA, artifact IDs, complete archive and extracted-file hashes/sizes,
configuration/architecture/ABI, symbols, licenses, catalog/certificate identity,
and the prebuilt packer's source/interface/format. Floating refs and latest-run
selection are unsupported. Dirty root sources and unidentified builds are refused.

Create a selection JSON with `schemaVersion: 1`, `rootRevision`, `configuration`
and an `artifacts` array. Every row has exact `repository`, `artifactId`, `runId`
and `runAttempt`. Supply all thirteen variants listed by `REQUIRED` in
[the verifier](../tools/wb/bundles.mjs). Artifact metadata and the successful
workflow are checked using GitHub's API; expired artifacts, fork runs, rerun
attempt mismatches and archive digest mismatches fail closed.

```sh
wb bundle lock --selection selection.json --artifacts-dir out/release-download
wb job wait --id <returned-job-id> --timeout 45 --json
wb bundle verify --manifest <returned-release-input> --artifacts-dir out/release-download
wb bundle assemble --manifest <returned-release-input> \
  --artifacts-dir out/release-download --name <assembly-devbox>
wb job wait --id <returned-job-id> --timeout 45 --json
```

`lock`, `fetch`, `prepare`, `complete` and `assemble` return durable jobs by default. `verify` is
synchronous unless `--background` is supplied. Use `--foreground` for CI or an
explicit blocking CLI check. MCP tools `bundle_lock`, `bundle_fetch`,
`bundle_verify`, `bundle_prepare`, `bundle_complete` and `bundle_assemble` proxy these same operations; `background:
false` selects foreground execution. Retry IDs, bounded waits and retained
evidence use the existing job families. Reconnect MCP after loading the updated
Nix execution closure; the previously connected server retains its old catalog.

Artifact downloads require a clean destination. Previously downloaded ZIPs are
retained under project-owned `.state/release-archive-cache/`, keyed by SHA-256.
`lock` and `fetch` recheck GitHub metadata and the cached file's full digest/size
before reusing it. Cache reuse never selects a different artifact or skips member
verification; a corrupt cache entry fails. Hard links avoid duplicate storage on
one filesystem, with an exclusive copy across filesystems.
The exact ZIP and every member
are checked before assembly. Windows packing additionally verifies driver
resource versions/branding, the catalog signer/certificate, and SHA256 catalog
membership of all five driver images without modifying the machine trust store.
It runs the already built packer as a durable SYSTEM task on local guest disk.
Catalog membership uses the prebuilt `VerifyCatalog.exe` from its own Helios
catalog-verifier artifact; assembly does not compile an interop DLL or probe.
No compiler, signing, catalog generation, dependency fetching or guest install
runs in this assembly task. A real packed output must pass its `HLIOSET2` footer
and container digest check before a candidate receipt is published.

The output under `out/bundles/<operation-id>/` retains `HeliosSetup.exe`, the
loose verified install payload for existing CLI/MCP installation, all exact
component archives (including symbols and host closures), and a release
manifest. Payload digests can be compared across local/CI assemblies. A local
mocked transport comparison does not establish real packer or hosted byte
reproducibility. Installation, loaded verification and publication remain false
in a candidate receipt.

The QEMU build artifact contains QEMU's executable, matching modules, x86
firmware, symbols, notices and unit/frontend validation reports. It builds the
`qemu-helios` target rather than exporting `host-stack`. Directory links into
its immutable outputs are enumerated and every member is hashed and copied;
the archive does not duplicate those files in a complete Nix host closure.
Dependency store paths and hashes remain in the original build manifest.
This is a component build artifact; its Nix runtime dependencies are resolved
separately when composing a runnable host environment. Full host closures remain
part of devbox/environment operations.

## Hosted assembly and publication

The root [candidate workflow](../.github/workflows/assemble-release-candidate.yml) only
checks out exact inputs, verifies/downloads archives, packs and retains a
reviewable candidate. It has read permissions and no release publication step.
It neither compiles components nor runs the installer build script.

The assembly source revision and the review-data revision are separate dispatch
inputs: an input manifest cannot contain its own Git commit hash. Each artifact
selection can specify `buildRootRevision`, the exact root commit that built it.
The verifier requires that revision in both the normalized and original build
manifests, alongside the selected component pins, toolchain lock, architecture
and dependency identities. Omitted values default to the assembly source revision.
This allows a driver CI fix to reuse already successful component artifacts
without rebuilding unrelated binaries or rewriting their provenance.
Generate/review the release-input JSON, then store it in a separate data commit.
Root CI checks out the selected assembly source
revision and reads the data commit under ignored `out/review/`. It checks the
reviewed JSON digest before using it. Component builds use the `component-build` environment; root candidate jobs
use ordinary hosted runners and manually reviewed immutable selections.
PRs/forks never execute these workflows or receive their private runner inputs.

`COMPONENT_INPUTS_TOKEN` needs Contents read for root checkout and Actions read
on each component repository; a repository's `GITHUB_TOKEN` generally does not
grant cross-repository artifact access. A fine-grained token or GitHub App can
provide that scope. Do not grant publication permissions to the read token.
Missing/expired tokens or artifacts are reported, not replaced with another run.
CLVK source sync includes Helios because its declared target consumes the Helios
loader and probe sources as well as CLVK. Source-sync steps supply the same read
token. The Nix command configures Git's
GitHub credential helper for that process, keeping credentials out of URLs and
leaving the user's Git configuration untouched. Private dependencies require
Contents read access across repositories even when the build repository is public.

The root workflow uses hosted Ubuntu for input verification/preparation, hosted
Windows for the shared prebuilt packing script, and hosted Ubuntu for final
verification and retention. It transfers artifacts by exact IDs from that run.
`wb bundle prepare` creates the hashed packing request; `wb bundle complete`
re-verifies the exact components, receipt, prebuilt PE stub and every decoded
container member. Symbols/licenses and host closures are streamed for verification
and retained inside their original ZIPs instead of expanded to disk. The same
logic also serves local devbox assembly. Root jobs need no named devbox or private
state. A separate release publication requires authorization and a verified candidate.
Source publication proceeds children before parent gitlinks and root pins.
The required Stage 5 baseline is checkpointed in `7e4fcf9`, followed by the
publication transport correction in `a5b2b18` and the Stage 6 implementation.
Source publication and final remote verification are recorded in the evidence.

Acceptance still requires real runs of all component workflows, a clean exact
download, local/hosted packing comparison and compilation-free hosted logs.
Then use a fresh named devbox to exercise signing reboot, install/resume,
repair/update, uninstall/snapshots and actual registry/kernel/DLL/interactive
observations. Existing guests, keys, media, images and closures remain preserved.
Stage 7 removals and fresh-host migration remain separate.
