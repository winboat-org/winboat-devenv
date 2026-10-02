# Stage 2 handoff prompt

Stage 1 supplies the locked workspace and repository/MCP control plane. All
twelve canonical objects are verified and synced into ignored `repos/`; root
checkpoints are local only. Acceptance and its boundaries are recorded in
[validation](../validation.md). Paste this into the next session:

```text
Implement Stage 2 of winboat-devenv through docs/stages/02-builds.md.

Read AGENTS.md, README.md, docs/architecture.md, docs/repositories.md,
docs/workspace.md, docs/validation.md, docs/reference-audit.md and the stage
index/spec before changes. Inventory root and nested Git status; preserve
unrelated work and external reference checkouts. Use the genuine committed
devenv.lock and the locked shell for routine execution. Do not refresh inputs
or patch external tooling as a routine troubleshooting step. Keep validation
focused on meaningful build/integration behavior, not upstream shell activation.

Stage 1 is implemented in nix/commands/repos.nix, tools/wb/ and
tools/mcp/server.mjs. The Node server is a typed spawn proxy for the same Nix
application. Reuse its JSON receipts and durable job operations; keep component
build logic in Nix-defined operations. Claude and Codex launch winboat MCP with
devenv shell -- wb mcp. Do not duplicate build logic in Node or change approval
settings. See docs/workspace.md for scoped checkpoints, publication recovery,
fork URLs and the absolute-Git bypass limitation.

The CLI/modules are locked to fe20b5cba7ab5e93ae73f956a8d3efc50e1753f4.
All twelve source pins are resolved. WBFreeRDP uses winboat-3.30 at
24b2e41269ecd04b9cd2dbea72fb8406b69b16a0; Electron uses winboat-43.2.0 at
c328b030fd3357139f66c8a3a84a4384c0136eed. Preserve the paired graphics seed
and current gitlink layout until consumers migrate together. DXIL-SPIRV's
canonical development ref is master; helios-native-fl12 is reference-only.
WinBoat's canonical ref is main, whose tip differs from the gpu-accel seed.
Do not force that seed onto main. Reference work remains outside managed repos.

Add standalone, composable devenv.nix/nix recipes to the six Helios repositories
and root adapters for third-party/WinBoat/WBFreeRDP/Electron/CLVK. Inventory real
targets and ABI/CRT constraints before selecting toolchains. Preserve native
static-CRT DXVK/vkd3d engine libraries needed by UMD11/UMD12. Define explicit
source/dependency/target/configuration/output contracts and immutable artifact
manifests with hashes, dependency/toolchain identities, licenses and symbols.

Build the native QEMU/renderer/Venus protocol closure in isolated outputs and
verify executable/modules/data/dependency identity. All 16 QEMU submodules and
LookingGlass are currently uninitialized: declare only proven build requirements
or supply them from Nix; never run recursive QEMU bootstrap. Generate Venus
headers once from its exact pin. Account explicitly for Meson wraps and Electron
Chromium/depot_tools inputs; no uncontrolled build-time downloads.

Expose wb build targets and MCP proxies through shared operations. Cross-build
a supported Windows user-mode output and inspect PE/import/CRT metadata.
Windows MSVC/WDK builds dispatch through the future devbox and must report their
unavailable backend clearly; runtime verification remains Stage 4. Do not
provision Windows, build an installer in root release CI, replace old win-mcp,
remove submodules or claim driver/DLL loaded-state acceptance in this stage.

Commit validated component recipe checkpoints with explicit path scopes,
then matching parent gitlinks and root pins. The Stage 1 checkpoint receipt
retains source commits and pending parents; it does not pretend they have been
published. If recording unpublished local pins, verify objects through explicit
ignored workspace.remotes overrides pointing at the managed checkouts and
record that canonical remote reachability is pending. Keep host paths out of
tracked sourceUrl fields. Finish with coherent parent/child pins. Do not push
to GitHub unless the user separately requests publication; when authorized,
publish dependencies before parents using wb repo push and reconcile retained
receipts. Never claim remote reproducibility for local-only commits.

Run appropriate component/build acceptance and the existing devenv test suite.
Record unavailable SDK/hardware checks accurately. Update stage status, build
usage and artifact contracts; commit validated checkpoints locally and provide
a Stage 3 handoff. Native interactive Fish activation has an upstream path
quoting limitation for spaces; explicit devenv shell -- commands remain the
supported agent path. Do not rebuild an activation regression harness.
```
