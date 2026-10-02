# Repository and pin policy

`nix/repositories.nix` is the inventory; `nix/pins.nix` is the sole source-revision
pin file. `devenv.lock` separately pins Nix packages/modules. Nix evaluation
exports the combined manifest, so CLI and MCP never maintain another list.

## Inventory and layout

All canonical URLs use `https://github.com/winboat-org/<repository>.git`.
Transport and contributor namespace are local choices, not canonical identity.
Layout version 1 preserves the existing Helios gitlinks and build paths:

| Repository | Path relative to workspace | Ownership |
| --- | --- | --- |
| helios | `repos/helios` | Top-level checkout |
| qemu-helios | `repos/helios/qemu-helios` | Helios gitlink |
| dxvk | `repos/helios/dxvk-helios` | Helios gitlink |
| virglrenderer | `repos/helios/virglrenderer` | Helios gitlink |
| mesa-helios | `repos/helios/icd/mesa` | Helios gitlink |
| vkd3d-proton | `repos/helios/vkd3d-proton-helios` | Helios gitlink |
| dxil-spirv | `repos/helios/vkd3d-proton-helios/subprojects/dxil-spirv` | vkd3d gitlink |
| venus-protocol | `repos/helios/venus-protocol` | Current Helios gitlink; Mesa ownership is the migration target |
| winboat | `repos/winboat` | Top-level checkout |
| WBFreeRDP | `repos/WBFreeRDP` | Top-level checkout |
| electron | `repos/electron` | Top-level checkout |
| clvk-helios | `repos/clvk-helios` | Top-level checkout |

Stage 7 can flatten former Helios submodules into independent checkouts once
recipes accept explicit dependencies. DXIL-SPIRV retains its parent relationship;
Venus protocol moves to Mesa ownership as requested. Version the manifest layout
and migrate existing workspaces explicitly. Never create duplicate writable
checkouts of a logical repository or rewrite the reference checkout in place.

## Subsets

| Selector | Explicit members | With managed dependencies |
| --- | --- | --- |
| `helios` | helios, qemu-helios, dxvk, virglrenderer, mesa-helios, vkd3d-proton | Adds dxil-spirv and venus-protocol: 8 repositories |
| `winboat` | winboat, WBFreeRDP, electron | 3 repositories |
| `winboat-accel` | WinBoat subset + Helios subset + clvk-helios | 12 repositories |
| `all` | Every inventory entry | 12 repositories |

The requested `clkvk-helios` spelling refers to canonical `clvk-helios`; any CLI
alias must resolve to that identity rather than create a second repository.
Dependencies are inputs/build consumers; parent edges record Git containment.
Selection computes dependency closure, while clone planning also makes required
parent containers available. Publication orders child gitlinks before parents.

## Seed provenance and readiness

The seed was read on 2026-10-02 from the existing Helios reference checkout at
`52c02799a042ecab25b9e812db9c002ba98ddb7c`. Its six managed child gitlinks supply
the QEMU, DXVK, renderer, Mesa, vkd3d and Venus revisions. vkd3d's gitlink supplies
DXIL-SPIRV. CLVK is the exact revision declared in that Helios CI snapshot.
WinBoat is the local `gpu-accel` checkout at
`17563cacb82ca31efe5feb12e3968f51951f1085`; its untracked files are excluded.

These ten revisions describe source objects, not deployed versions or a tested
bundle. Remote availability was not verified because shell networking was
unavailable. Local remote aliases/URLs differ from the canonical organization
for some children; confirm the seeded objects exist in the organization fork.
Do not replace a paired graphics revision with remote HEAD merely to make sync
succeed. An intentional update needs a coherent parent/pin change.

WBFreeRDP and Electron have `rev = null`: no verified object ID was available.
Stage 1 resolves them against the actual development refs and records the
provenance. A null `ref` with an exact `rev` permits pinned checkout, but does not
establish which branch a push should track. Discover/explicitly configure the
development ref before updating pins on push; never guess `main` or `master`.

`wb-check` checks scaffold structure. `wb-check --ready` also requires every
revision and a generated Nix lock. Stage 1 adds reachability and consistency
checks: pin presence alone is not remote verification. Subset readiness only
depends on the selected closure. Nothing substitutes floating HEAD for a null
pin or fabricates a fixed-output hash.

## Synchronization and publication

Sync restores declared commits; pin refresh is a separate explicit operation.
Dirty/index/conflict state is preserved. Normal sync must refuse an affected
checkout instead of stashing, resetting, cleaning or overwriting it. Preserve
work outside the selected closure. Adoption of existing checkouts is explicit,
local and validated; a source path is never inferred from a username.

Submodule updates use selected paths and their pinned gitlinks. QEMU starts with
an empty allowlist: **no full recursive QEMU submodule sync**. Stage 2 may declare
only a demonstrated build requirement, or provide it from Nix. DXVK/vkd3d's
third-party header/shader submodules are separately governed by their parent
gitlinks; record them in build provenance. LookingGlass is outside these subsets.

Inside the Nix environment, Stage 1's Git wrapper delegates ordinary Git actions
to the pinned Git executable. After a verified successful push to the managed
development ref, it records the **pushed** revision in `nix/pins.nix`, updates
necessary parent gitlinks, and creates a scoped pin checkpoint. Failure,
`--dry-run`, tags, deletes and unrelated branches do not advance pins. Explicit
`wb repo checkpoint` commits selected work at meaningful checkpoints. Shell
entry and ordinary sync do not silently commit source edits.

Fork mode changes `origin` to a chosen namespace, retains winboat-org as
`upstream`, and scopes changes to the selection. Validate fork/object access
and remotes before mutation. Namespace overrides stay local by default; a
shared fork pin is an explicit URL/revision change that remains reproducible.
Dependencies still at upstream SHAs can be fetched from upstream if a new fork
does not contain them. SSH config is generated locally; no custom host alias is
required for another contributor.
