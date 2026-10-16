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

The new source cohort still needs publication, exact hosted component artifacts
and a fresh installer assembly. Keep this separate from the earlier successful
installer/lifecycle/graphics acceptance. The broader Stage 7 fresh-host acceptance
and retirement of unrelated legacy tools remain pending.
