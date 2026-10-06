# Stage 6 handoff

Stage 6 sources are checkpointed and published. The supplied remote is configured as
`https://github.com/winboat-org/winboat-devenv.git`. Six repository-owned workflows,
the root prebuilt-only candidate workflow, migrated installer/shared payloads,
exact release contracts and `wb bundle` with four typed MCP tools are present.
See [release usage](../releases.md) and
[implementation evidence](../evidence/stage-06-implementation.json).

Hosted component runs, real local/CI packing, and fresh installer runtime
acceptance remain pending. The user authorized checkpoints and pushes. Stage 5
is checkpointed in `7e4fcf9`, and `a5b2b18` fixes canonical remote verification
when Git omits the SSH username from its destination display. All six component
repositories and their required recipe history are published, with exact remote
verification and coherent parent gitlinks/pins. The root implementation and
publication receipts are recorded in the evidence above. Root implementation
commit `db1ffc0` is published on `master`; all 12 managed checkouts are clean at
their declared pins. The combined checkpoint passed 113 native checks.

Root and all six components reported zero registered repository runners;
root/Helios had no configured environments. No runner registration, guest
mutations or release publication were performed. The local verifier/transport
fixtures and real Linux compatibility cross-build remain separate evidence from
the pending hosted/Windows gates. Reconnect the long-lived MCP server to load
the 53-tool catalog; publication used fresh locked stdio MCP sessions.

The original planning prompt below is retained for its full acceptance and
preservation requirements; the implementation checkpoint above supersedes its
description of which command families and workflows exist.
The scope and gates are in [Stage 6](../stages/06-ci-bundles.md).

Stage 5 passed its measured current-host acceptance. Read its
[handoff](stage-05.md) and [evidence](../evidence/stage-05-acceptance.json), together
with the historical [Stage 4 evidence](../evidence/stage-04-acceptance.json).
The current baseline has 80 passing native checks, fresh primary/package builds,
resumed installation, 13 interactive workloads, 12 mapped DLL identities and
verified resident kernel code. Codex programmatic tool calls and Claude connection
diagnostics passed; interactive trust UI and Claude model-driven turns remain
unmeasured. Trust-test instructions alone do not close those checks.

At the original Stage 5 handoff, root HEAD was `844e8f9` and Stage 5 plus
pre-existing root edits remained uncommitted. All 12 managed repositories were
clean at their declared pins, but several component recipe/fix commits and parent
pins remained local/unpublished. The root had no configured Git remote or
`.github/` directory. Those historical facts are superseded by the implementation
and publication evidence above.

The genuine locks remain unchanged:

| Lock | SHA-256 |
| --- | --- |
| `devenv.lock` | `676be455589fee75101e93bd8ba1e23b7f6389b00780f53294173494c7000fcc` |
| `config/provision.lock.json` | `73ace512793bae2ece3a3ecda2507fa4401abce7470fef783945c9b0ecc3b408` |

The next session can start with this prompt:

```text
Implement Stage 6 of winboat-devenv through docs/stages/06-ci-bundles.md.

Read AGENTS.md, README.md, docs/architecture.md, docs/repositories.md,
docs/stages/README.md, docs/stages/06-ci-bundles.md, docs/handoffs/stage-05.md,
docs/evidence/stage-05-acceptance.json, docs/builds.md, docs/windows-control.md,
docs/reference-audit.md and docs/validation.md before changes. Inventory root
and nested Git status, remotes, source pins and available artifacts. Preserve
the uncommitted Stage 5 work, unrelated root edits, external reference checkouts,
original guests, keys, media, receipts and artifact closures. Discover current
paths and use local overrides rather than copying personal machine paths.

Use connected WinBoat MCP for routine workspace/repository/build/devbox/job
operations. The restarted Stage 5 catalog exposes 49 tools, including job_wait,
devbox_job_wait, job_logs and evidence_read. Discover schemas in the new session;
investigate/report stale or missing connections. Use CLI for explicit CLI/shell
integration checks or operations without an MCP equivalent. Native devenv
activation and Codex command refresh are already installed. Run commands
directly in that environment; use devenv shell -- <command> when it is absent,
such as on a CI runner. Never inspect devenv's internal state directory. Use
git on PATH, declare tools/execution in Nix and preserve genuine input locks.
Reconnect MCP after Nix execution or schema changes. SSH keys, pinned host keys
and private SSH configuration are automatic; no separate SSH setup is needed.

The ownership rule is strict: component repositories compile binaries; root
release CI only verifies and bundles already built artifacts. Root CI must not
compile the installer, drivers, DLLs, probes, loaders or compatibility shims,
including through an indirect script or fallback dependency build.

First audit the current component recipes and legacy packaging interfaces.
Component Nix entry points live in helios, qemu-helios, dxvk, virglrenderer,
mesa-helios and vkd3d-proton. Root adapters declare CLVK/loaders and other
third-party closures. Shared execution is declared under nix/, with the Node
control plane in tools/wb/ and typed MCP proxy in tools/mcp/server.mjs. Reuse
those operations and receipts rather than inventing a second CI build system.

Inspect repos/helios/.github/workflows/windows-stack.yml, installer/README.md,
installer/src/archive.rs, ci/windows/Build-Installer.ps1,
ci/windows/Assemble-Package.ps1 and packaging/windows/ from the exact selected
Helios pin. The legacy package job compiles its installer before assembly;
that compilation must become an individual Helios component job. The existing
packer interface is HeliosSetup.exe --bundle <payloadDir> <out>. Audit actual
code and payload requirements before migrating; README descriptions are not
proof that a new assembly path is compatible.

Implement coherent slices in this order:

1. Define a versioned release-input contract for exact component artifacts.
   Include repository, workflow/run and artifact identity, commit, dependency
   commits, configuration, variant/architecture/ABI, toolchain, archive digest,
   extracted file hashes/sizes, symbols/licenses and signing/catalog identities.
   Record the exact root source commit and packer interface/version used for
   the prebuilt installer. Require source pins and artifact provenance to agree;
   reject dirty/unidentified inputs for release candidates. Never select latest
   successful runs or floating branches. Treat existing artifact and install
   manifests as distinct schemas with explicit conversion/verification.

2. Add or adapt repository-owned workflows for helios, qemu-helios, dxvk,
   virglrenderer, mesa-helios and vkd3d-proton. Pin actions to verified commits
   and cache by immutable source/toolchain/dependency identities. Cross-compile
   Windows dependencies wherever possible: DXVK/vkd3d engines and Mesa x64/x86,
   plus CLVK/loaders, already have Linux MSVC/static-CRT recipes. The primary
   Helios WDK build has a documented Windows-host blocker. ABI or static CRT
   alone is not a reason to use Windows. Define designated production of CLVK,
   Khronos loaders, probes and compatibility payloads consumed by the release;
   root bundling never builds them to fill a missing artifact. Record paired
   Venus and DXIL-SPIRV provenance. Preserve QEMU executable/modules/data as
   one exact closure, x64/WoW64 outputs, runtime symbols and license notices.
   Preserve the current LLVM/Clang no-debug-symbol policy.

3. Migrate installer source and shared assembly/install payloads into the root
   repository with explicit source-commit/path attribution and retained history.
   Keep originals until migration gates pass. A designated Helios component job
   checks out the exact selected root source commit and builds the installer
   executable, symbols and interface/source manifest. The root remote must be
   supplied once known; do not invent an organization URL. Uncommitted source
   cannot be represented as an immutable hosted installer source revision.

4. Implement wb bundle and its typed MCP proxy through shared Nix-declared
   operations. This family does not exist yet. Require an exact release-input
   manifest and supplied artifact directory; verify every input before assembly.
   Root CI must invoke the same assembly path, download exact artifacts and run
   the already built packer. A Windows assembly runner is acceptable. Disable
   dependency-build fallbacks. Existing helios-development-package is a local
   development composer whose omitted dependencies can trigger builds; it is
   not evidence of a compilation-free release bundler. Return a durable job,
   structured completion and retained release manifest/hashes.

5. Add root verification/assembly workflows and generalized usage documentation.
   Handle cross-repository token scope, artifact expiry and fork PR restrictions
   explicitly. Do not expose publication credentials to untrusted PR code.
   Separate generating a reviewable candidate from publishing a release. Missing
   root remote, unpublished inputs, runner access, credentials or media leave
   their specific hosted/runtime gates pending, not silently satisfied by local
   tests. This handoff does not authorize commits, pushes or release publication;
   follow the implementation session's authorization for scoped checkpoints and
   dependency-first publication.

Preserve the user-facing installer contract: silent install/repair/update and
uninstall; --automatic durable reboot/resume; native 3010 reboot-required status;
waiting, test-signing-restart-required, driver-restart-required, finished and
failed provisioning states; stored uninstall payloads and registry snapshots.
Preserve the self-contained SHA-256-checked HLIOSET2 archive format and safe
extraction boundaries. Keep one shared PowerShell install implementation across
installer, CLI and MCP. Include Release/Debug distinctions in artifact selection.
Runtime PDBs stay in their component/symbol artifacts; the accepted development
install bundle contains zero PDBs. Never discard symbol/license provenance.

Complete acceptance with separate evidence for each gate:

- Real component workflow runs must build each required artifact with exact
  source/dependency/toolchain provenance. Local recipe builds and YAML parsing
  do not establish hosted CI acceptance.
- Download the exact artifacts into a clean directory. Assemble locally and
  through root CI; compare payload hashes. Record expected container/metadata
  variability if final packages differ. Pinned inputs alone do not prove byte
  reproducibility. Verify root workflow logs contain no binary compilation.
- Negative assembly cases must reject missing artifacts or wrong commits,
  x86/x64 mismatches, protocol/engine pairing mismatches, corrupt hashes, wrong
  signing/catalog identity, missing licenses, duplicate payload paths and stale
  installer interfaces before publication or guest changes.
- Use a fresh named devbox for the resulting prebuilt installer. Verify
  unattended test-signing/reboot, install/reboot/resume to finished, repair/
  update, uninstall and preserved snapshots/rollback evidence. Installation
  success must include actual registry/files, mapped DLL identities, resident
  kernel code and interactive smoke observations. Desired/built/installed/loaded
  identities remain separate. Desktop probes require a real interactive session;
  builds/installs use durable elevated tasks and local guest disk mirrors.
- The Stage 5 acceptance guest ended stopped with clean shutdown, retaining
  its original supervisor/image/keys. New-supervisor fresh-container boot,
  another physical host and visual/conformance acceptance remain unmeasured.
  Validate the selected fresh guest's runtime separately; preserve existing
  guests and their runtime/store bindings. A shutdown timeout preserves the VM.
- Run relevant native checks, wb-windows-check for changed Windows payloads,
  formatting/whitespace checks and devenv test. Retain genuine logs/manifests,
  update Stage 6 status and record exact passed/pending gates and blockers.

Keep Stage 7 removals separate: do not retire win-mcp, legacy installers,
environment scripts or submodules before replacement and fresh-host migration
gates pass. Complete WinBoat/Electron closures, canonical publication, driver
conformance and client trust/model-turn checks remain separate recorded limits;
they cannot be inferred from a successful release assembly.
```
