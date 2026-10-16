# Component ownership and layout migration

The Stage 6 guest-only installer assembly passed again with Node 24 actions in
[run 38903084828](https://github.com/winboat-org/winboat-devenv/actions/runs/38903084828).
That run uses the accepted earlier source/input cohort. It does not validate the
new component ownership changes below.

The current cleanup moves the whole Helios packaging tree and its producer
workflows to winboat-devenv. CLVK owns its DLL workflow and clspv patches;
winboat-devenv builds the Khronos loaders and package probes separately. Helios
builds only its KMD/UMD outputs with exact prebuilt engines and bridge headers.
Mesa owns its ICDs, manifests and compatibility headers. Obsolete combined,
foreign-component and duplicate ABI workflows are retired. Every retained
graphics/packaging workflow uses immutable Node 24 action pins and hosted runners.
Component producers run on default-branch pushes and preserve the exact resolved
root revision plus their canonical dependency pins in provenance.

Layout version 2 has independent QEMU, DXVK, renderer, Mesa and vkd3d checkouts;
Venus lives under Mesa and DXIL-SPIRV remains under vkd3d. All six old managed
Helios gitlinks are removed. Existing worktrees and Git directories were moved,
with their heads, refs, remotes, staged/unstaged and untracked work verified.
The completed local adoption receipt is
`.state/layout-migrations/op-0980825ee9c7437283e8ffb4917c6da7/plan.json`.
`wb-migrate-layout --plan|--apply` handles other version 1 workspaces;
`--recover <component-receipt.json>` reverses a component move without deleting it.
The original guests, source history and retained build archives remain intact.

Validation passed 129 native tests and the PowerShell checks in
`.state/validation/native.EMdaQ6nd.log`. Local workflow validation also passed for
all retained graphics/packaging workflows. There is no hosted workflow-lint job.
The migration tests exercise real Git adoption, nested metadata, dirty work,
recovery and conflicting destination refusal.

The new source cohort still needs its remaining hosted component artifacts
and a fresh installer assembly. Keep this separate from the earlier successful
installer/lifecycle/graphics acceptance. The broader Stage 7 fresh-host acceptance
and retirement of unrelated legacy tools remain pending.

## Publication and hosted checks, 2026-10-16

Root ownership implementation is `0564c26`; packaging path filters in `c347f42`
skip component-pin-only pushes. Source pins through `ca5ceb1` are published.
Component checkpoints are DXVK `aaca727`, vkd3d `6862ca7`, renderer `34ef854`,
QEMU `6577af9`, CLVK `cfb2f21`, and Mesa `162130a`. Helios `ef3ec2a` is published and its driver build is running as `38912082120`.
All twelve pinned source objects passed canonical remote verification;
[the source receipt](../evidence/component-ownership-sources.json) records their identities.

All packaging producers passed from root `c347f42`: loaders/probes `38908874043`,
catalog verifier `38908874872`, ADL shim `38908874440`, and installer plus Windows
interface `38908874409`. QEMU `38908617323`, renderer `38908597729`, and vkd3d
`38908638495` passed. QEMU's artifact is 142,507,902 bytes and remains separate
from the guest distribution. An annotation audit of these seven runs/nine jobs
found no deprecated Node runtime warnings.

Mesa's initial push selected the pre-migration root before publication finished.
Its next attempt exposed a branding include omitted during the header move;
`7efd19e` and `162130a` fix the include directory, own the branding input and
remove Helios paths from its Windows interface. Current Mesa run: `38910066348`.
The Windows interface passed local PowerShell checks.

DXVK's push run `38908559584` passed after retrying a Microsoft SDK range-read
timeout, but its artifacts span attempts. Complete-cohort run `38910673158`
keeps both architectures in one successful attempt for exact release selection.
CLVK run `38908713541` is building in its own repository. Its previous equivalent
LLVM-based compiler build took about two hours. CLVK's local checkout lacked
ancestor objects; fetching complete history fixed publication without rewriting
its source or remote history. Current CI receipts/watch logs are under
`.state/stage06/ownership-*` and `*-cohort-watch.log`.
