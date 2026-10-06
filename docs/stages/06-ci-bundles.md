# Stage 6 — Component CI and bundling-only release CI

Status: implemented locally; hosted component/candidate runs, real packed output
and fresh installer runtime acceptance pending. Prerequisites: Stages 2 and 4.
Agent setup is useful but not a prerequisite.

[Release usage](../releases.md) describes the exact-input contracts, six component
workflows, prebuilt-only root workflow and shared CLI/MCP operations.
[Implementation evidence](../evidence/stage-06-implementation.json) keeps local,
hosted and Windows runtime gates separate. The user authorized source checkpoints
and pushes after implementation. The six component repositories are published
at their verified pins; the root checkpoint records the required Stage 5 baseline
and Stage 6 sources. Release publication remains a separate operation.

The [implementation handoff](../handoffs/stage-06.md) records the Stage 5 baseline,
current publication boundaries and a next-session prompt for this stage.

## Outcome

Each component repository builds its own individual artifacts. Root release CI
verifies and combines exact artifacts, including a prebuilt installer, into
Helios DLL/driver/install bundles without compiling any binaries.

## Implementation

1. Add GitHub build workflows to helios, qemu-helios, dxvk, virglrenderer,
   mesa-helios and vkd3d-proton. Reuse component Nix entry points and the declared
   Windows operations/toolchain where Nix cross compilation cannot preserve ABI.
   Define DXIL-SPIRV/Venus dependency provenance and designated CLVK/loader
   artifact production; a root bundler must not compile them as a fallback.
   Pin actions and dependencies, cache by immutable source/toolchain identities,
   and publish manifests, symbols/licenses and actual artifact hashes.
2. Use a concrete release-input manifest referencing repository, workflow/run,
   commit, component/variant/ABI, artifact identity/digest and required dependency
   commits. Consumers reject missing/mismatched/unverified artifacts and duplicate
   payload paths. Avoid choosing a latest-successful artifact across repositories;
   root source pins and artifact sources must agree. Handle GitHub token scope,
   cross-repo download, artifact expiry and fork PR restrictions explicitly.
3. Migrate installer source and common package assembly/install payloads here,
   retaining attribution/history and the current archive/reboot protocol.
   **Compile the installer in a designated Helios component build job** that
   checks out the exact selected root source commit. Publish its executable,
   packer interface/version, symbols and source identity as an individual artifact.
   The root repository's remote name is supplied/configured once known; do not
   invent one or resolve installer source through a floating branch.
4. Add root CI for verification, assembly and bundling only. Download the exact
   KMD SYS/INF/CAT/certificate, UMD11/UMD12, engine/runtime DLLs, Mesa ICDs,
   CLVK/loaders, symbols/licenses and already built installer. Verify manifests,
   architecture/configuration, paired protocol/engine ABI, file hashes and the
   signing/catalog identities before assembly. Include Release/Debug differences
   explicitly. Run the prebuilt installer/packer assembly entry point (a Windows
   runner is acceptable); never invoke cargo, Meson, Ninja or a compiler to build
   a component or installer in root release CI.
5. Preserve silent install/uninstall, registry snapshots, unattended reboot/resume
   states and self-contained hashed archive behavior. `wb bundle` runs the same
   assembly outside CI, with an artifact directory/manifest input and full receipt.
   Produce a release manifest with exact payload/install source identities and
   hashes. Separate creating a reviewable candidate from publishing a release.

## Acceptance

Build each declared component through its repository workflow and verify source/
dependency/toolchain provenance. Download artifacts into a clean directory and
assemble the same bundle locally and through root CI. Compare payload hashes
and record expected container/metadata variability if the package is not byte
reproducible; never infer determinism solely from pinned inputs.

Run negative assembly cases for a missing/wrong commit, x86/x64 mismatch,
protocol pairing mismatch, corrupt hash, wrong catalog, missing license and a
stale installer interface. All must fail before publication. Confirm root
workflow logs contain no binary compilation steps.

Test the resulting prebuilt installer in a fresh devbox: unattended test-signing
reboot, install/reboot, finished status, registry verification, repair/update and
uninstall with preserved snapshots. Preserve rollback evidence. Hosted CI proof,
local recipe proof and runtime installation proof are recorded separately;
credentials or runner/media restrictions leave their specific gates pending.
