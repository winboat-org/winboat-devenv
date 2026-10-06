# Exact component artifacts and release candidates

Stage 6 supplies repository-owned component workflows and a shared verifier and
packer. Hosted runs and fresh installer acceptance remain pending; the measured
scope is recorded in [Stage 6 evidence](evidence/stage-06-implementation.json).

The root remote is `https://github.com/winboat-org/winboat-devenv`. It was verified
empty before source publication on 2026-10-06. The user subsequently authorized
checkpoints and pushes; the six component repositories are published at verified
canonical revisions. No repository runners were registered in root or any of the
six components, and root/Helios had no configured environments. Hosted acceptance
still needs prepared runners and their inputs. No release was published.

## Production ownership

The six component repositories contain `.github/workflows/stage06-component.yml`.
The shared template is [ci/stage06-component.yml.in](../ci/stage06-component.yml.in).
Only manual dispatch runs are enabled. Every run selects a 40-character root
source revision, an exact component workflow/source revision and `release` or
`debug`. The workflow SHA must equal the corresponding root source pin.
Actions are pinned to API-verified commits, not floating tags.

| Workflow owner | Artifacts |
| --- | --- |
| Helios | Signed x64 KMD and native/WoW64 UMDs, migrated installer, compatibility shim and prebuilt catalog verifier, CLVK/loaders/native and WoW64 probes |
| QEMU | Exact host-stack output, including QEMU executable/modules/data, renderer, paired headers, host smoke and complete Nix closure |
| DXVK | x64 and x86 MSVC/static-CRT engine archives |
| virglrenderer | Renderer and paired Venus headers, symbols/licenses and complete closure |
| Mesa | x64 and x86 Venus/Zink/OpenGL outputs with paired Venus provenance |
| vkd3d-proton | x64 and x86 MSVC/static-CRT engine outputs and DXIL-SPIRV provenance |

Linux cross compilation supplies DXVK, vkd3d, Mesa, CLVK/loaders/probes and the
compatibility shim. Helios retains the documented Windows WDK build-script
blocker. The migrated installer also retains its native Windows build entry:
`build.rs` executes `rc.exe` and uses Windows SDK path discovery. Its Cargo
dependencies are vendored from the unchanged installer lock through Nix, and
its durable Windows build uses a local source copy and `CARGO_TARGET_DIR`.
These are concrete script/tool limitations, not consequences of the MSVC ABI.

The Helios driver job requires four exact artifacts from the DXVK/vkd3d jobs,
using JSON selectors with `repository`, `artifactId`, `runId`, and `runAttempt`.
It imports and verifies their original build manifests, configuration and source
identities. Missing engines fail before driver compilation; no dependency-build
fallback is used. CLVK's designated Helios job uses the existing Linux recipe and
retains its fixed Khronos/LLVM revision table and no-compiler-symbol policy report.

Prepared Linux runners need label `winboat-build`; assembly runners need
`winboat-assembly`. Nix/devenv and the locked offline EWDK/provisioning inputs
must already be available. Windows component jobs need a prepared, verified named
devbox. Runner-local `WB_CI_STATE_ROOT` can point to its private persistent state;
credentials, keys, media and state are never included in source caches or artifacts.
Nix derivation caching uses complete immutable source/dependency/toolchain inputs.
The workflow's source-object cache key includes root/component revisions, locks,
pins, target and configuration; it contains no guest state.

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
`winboat-component-artifact` schema 1, and `winboat-release-input` schema 1.
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
and `runAttempt`. Supply all twelve variants listed by `REQUIRED` in
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

`lock`, `fetch` and `assemble` return durable jobs by default. `verify` is
synchronous unless `--background` is supplied. Use `--foreground` for CI or an
explicit blocking CLI check. MCP tools `bundle_lock`, `bundle_fetch`,
`bundle_verify` and `bundle_assemble` proxy these same operations; `background:
false` selects foreground execution. Retry IDs, bounded waits and retained
evidence use the existing job families. Reconnect MCP after loading the updated
Nix execution closure; the previously connected server retains its old catalog.

Artifact downloads require a clean destination. The exact ZIP and every member
are checked before assembly. Windows packing additionally verifies driver
resource versions/branding, the catalog signer/certificate, and SHA256 catalog
membership of all five driver images without modifying the machine trust store.
It runs the already built packer as a durable SYSTEM task on local guest disk.
Catalog membership uses the prebuilt `VerifyCatalog.exe` from the Helios
compatibility artifact; assembly does not compile an interop DLL or probe.
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

## Hosted assembly and publication

The root [candidate workflow](../.github/workflows/release-candidate.yml) only
checks out exact inputs, verifies/downloads archives, packs and retains a
reviewable candidate. It has read permissions and no release publication step.
It neither compiles components nor runs the installer build script.

The source revision and the review-data revision are separate dispatch inputs:
an input manifest cannot contain its own Git commit hash. Build all components
from one committed source revision, generate/review the release-input JSON, then
store that JSON in a separate data commit. Root CI checks out the original source
revision and reads the data commit under ignored `out/review/`. It checks the
reviewed JSON digest before using it. Configure protected `component-build` and
`release-candidate` environments to admit only approved maintainer dispatches.
PRs/forks never execute these workflows or receive their private runner inputs.

`COMPONENT_INPUTS_TOKEN` needs Contents read for root checkout and Actions read
on each component repository; a repository's `GITHUB_TOKEN` generally does not
grant cross-repository artifact access. A fine-grained token or GitHub App can
provide that scope. Do not grant publication permissions to the read token.
Missing/expired tokens or artifacts are reported, not replaced with another run.

Assembly runners supply `WB_CI_STATE_ROOT` and `WB_CI_ASSEMBLY_DEVBOX`. A separate
publication operation requires owner authorization and a verified candidate.
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
