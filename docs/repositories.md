# Repository and pin policy

`nix/repositories.nix` is the inventory; `nix/pins.nix` is the sole source-revision
pin file. `devenv.lock` separately pins Nix packages/modules. Nix evaluation
exports the combined manifest, so CLI and MCP never maintain another list.

Stage 2 adds local recipe commits in the six Helios repositories, updates parent
gitlinks, and records coherent pins verified through ignored `workspace.remotes`
overrides to managed clones. The [Stage 2 evidence](evidence/stage-02-validation.json)
lists these exact commits. Canonical URLs stayed unchanged; new commit reachability
was pending at that checkpoint. Stage 1's canonical evidence describes the seed,
not publication of the new recipes. Stage 6 subsequently published those recipes
and the six repository-owned workflows through dependency-ordered Stage 1
transactions. [Stage 6 evidence](evidence/stage-06-implementation.json) records
the exact canonical refs, revisions and verification receipts. Historical local
build evidence retains its original source identities.

The Stage 3 follow-up adds a local QEMU EGL/GBM cleanup correction, its parent
gitlink/documentation commits and matching pins. These were published with the
Stage 6 component checkpoints.
[Runtime evidence](evidence/stage-03-runtime-portability.json) records the
corrected release artifact and separates local source coherence from canonical
remote reachability.

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
bundle. At scaffold creation, remote verification was blocked by networking;
Stage 1 resolved that check. Local reference aliases/URLs differ from canonical
organization URLs for some children; verification used the canonical sources.
Do not replace a paired graphics revision with remote HEAD merely to make sync
succeed. An intentional update needs a coherent parent/pin change.

Stage 1 resolved WBFreeRDP at `winboat-3.30` and Electron at `winboat-43.2.0`.
Their exact revisions and all ten unchanged seed objects were fetched from the
canonical organization URLs. The retained [source verification](evidence/stage-01-sources.json)
records advertised refs and object identities independently of seed provenance.

| Repository | Verified publication ref |
| --- | --- |
| helios, dxvk, vkd3d-proton, dxil-spirv | `refs/heads/master` |
| qemu-helios | `refs/heads/helios-11.1.1` |
| virglrenderer, mesa-helios, venus-protocol, clvk-helios | `refs/heads/main` |
| winboat | `refs/heads/main` |
| WBFreeRDP | `refs/heads/winboat-3.30` |
| electron | `refs/heads/winboat-43.2.0` |

The reference-only `helios-native-fl12` and `gpu-accel` branch names are absent
from the canonical DXIL-SPIRV and WinBoat remotes. Their source SHAs remain
unchanged. DXIL-SPIRV advertises that SHA on `master`; WinBoat's advertised
default is `main`, whose tip differs from the seed. Pin verification establishes
object availability and ref existence, not that every seed is a ref's current
tip or a tested graphics stack. Select an explicit fork URL/ref before publishing
local WinBoat development rather than forcing the reference branch onto main.

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
does not contain them. The tool leaves global Git/SSH configuration alone;
no custom host alias is required for another contributor.
