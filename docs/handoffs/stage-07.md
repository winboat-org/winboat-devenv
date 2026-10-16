# Component ownership and layout migration

The new ownership cohort passed all component builds and all three hosted
installer assembly jobs in
[run 38928618010](https://github.com/winboat-org/winboat-devenv/actions/runs/38928618010).
The [CI and assembly receipt](../evidence/component-ownership-ci.json) records the
exact inputs, final artifact, matching local installer and annotation audit.
All twelve audited runs/twenty jobs succeeded without deprecated Node runtime
warnings. Earlier guest-only assembly run `38903084828` remains historical.

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

Validation passed 130 native tests and the PowerShell checks in
`.state/validation/native.TNZ5mxA2.log`. Local workflow validation also passed for
all retained graphics/packaging workflows. There is no hosted workflow-lint job.
The migration tests exercise real Git adoption, nested metadata, dirty work,
recovery and conflicting destination refusal.

All component builds and local/hosted installer assembly passed for the new source
cohort. Hosted installer assembly is
[38928618010](https://github.com/winboat-org/winboat-devenv/actions/runs/38928618010).
Keep this separate from the earlier successful installer/lifecycle/graphics
acceptance. The broader Stage 7 fresh-host acceptance and retirement of unrelated
legacy tools remain pending.

## Publication and hosted checks, 2026-10-16

Root ownership implementation is `0564c26`; packaging path filters in `c347f42`
skip component-pin-only pushes. Source `094c006` records the final published pins.
Component checkpoints are DXVK `aaca727`, vkd3d `6862ca7`, renderer `34ef854`,
QEMU `6577af9`, CLVK `cfb2f21`, Mesa `162130a`, and Helios `d03c2d1`.
All twelve pinned source objects passed a fresh canonical remote verification
after the final Helios pin (`op-79becb72d97946aaa589af0967fab137`);
[the source receipt](../evidence/component-ownership-sources.json) records their identities.

The selected packaging producers passed from root `094c006`: loaders/probes
`38920546571`, catalog verifier `38920546494`, ADL shim `38920546543`, and installer
plus Windows interface `38920546559`. QEMU `38908617323`, renderer `38908597729`, and vkd3d
`38908638495` passed. QEMU's artifact is 142,507,902 bytes and remains separate
from the guest distribution. An annotation audit of all twelve build/assembly runs
and twenty jobs found no deprecated Node runtime warnings.

Mesa's initial push selected the pre-migration root before publication finished.
Its next attempt exposed a branding include omitted during the header move;
`7efd19e` and `162130a` fix the include directory, own the branding input and
remove Helios paths from its Windows interface. Mesa run `38910066348` passed.
The Windows interface passed local PowerShell checks.

DXVK's push run `38908559584` passed after retrying a Microsoft SDK range-read
timeout, but its artifacts span attempts. Complete-cohort run `38910673158`
keeps both architectures in one successful attempt for exact release selection.
CLVK run `38908713541` passed in its own repository. Its LLVM-based compiler build
took about two hours. CLVK's local checkout lacked
ancestor objects; fetching complete history fixed publication without rewriting
its source or remote history. Current CI receipts/watch logs are under
`.state/stage06/ownership-*` and `*-cohort-watch.log`.

The first Helios build compiled and signed successfully, but its final verification
job lacked `GH_TOKEN` for the default-branch metadata check. Workflow fix
`d03c2d1` supplies the same read token used by preparation; its new push run
`38916395471` passed. The pin checkpoint is `becf0db`. The private selection collector
targets this run. The complete cohort requires twelve variants (including
the separate guest-support artifact).

A follow-up guard prevents source sync from cloning replacement repositories
while an affected version 1 checkout still exists. Unrelated selections remain
available. The complete validation task passed 130 native tests plus PowerShell
checks; its log is `.state/validation/native.TNZ5mxA2.log`.

## Installer assembly, 2026-10-16

The exact source is `094c006367907cc717cf36b79adfced50f04329a`. Review-data commit
`a78fdadec373958a17e1c403602690c3d2fe8384` contains
[`winboat-release-inputs-ownership-20261016.json`](../release-inputs/winboat-release-inputs-ownership-20261016.json),
SHA-256 `a610eb8a1da6891ba6633dd6f62320d6a6178f7cc8a1dc994a28bf6bd44d2cb1`.

Local assembly job `op-e47b97064ead40ac80bb872f5d402280` succeeded using the prebuilt
installer and all twelve exact variants. It produced only `HeliosSetup.exe`
(38,626,130 bytes, SHA-256
`9cb2dff7f8057d82da301917133f576b4c62dc89e53081eacc59da22015f774c`)
and `release-manifest.json`. The payload has 32 runtime/probe files, 711 total
members including notices and packaging support, and digest
`631d509740d47ddfab1a98a0d0a7beae8ba382fae42c54dbc2585128633625ab`.
It contains the guest stack, packaging metadata and support files; host artifacts,
component archives and debug symbols stay outside the distribution.

Hosted run `38928618010` passed on its first attempt. Downloaded artifact
`12058630627` is 39,504,564 bytes, SHA-256
`4a461f46cdb6b531b1043cf0d063f7a5ba1d44a2fdff7170b07773001913c491`.
Its only members are the installer and release manifest under one operation
directory. The installer is byte-identical to local assembly and its payload
digest matches. The hosted release manifest is 878,012 bytes, SHA-256
`bf494d6b05cda1ad868bcb832b5d92d9e78b9540b4a39944f8d2a36c11af0921`;
operation-specific manifest fields differ from the local receipt.

The retained `release-acceptance-20261013` guest was used only for packing and then
shut down cleanly through SSH (`op-82188422a6a049c0960e1af7a1f38465`). No installation
or loaded-state acceptance was repeated for this cohort. The persistent WinBoat
MCP connection still advertises the old layout/schema; restart/reconnect it before
new repository/build/devbox operations. Fresh locked MCP servers performed this
task's operations with the current 55-tool schema.

The final repository inventory found all twelve managed checkouts clean and
matching their published pins. `devenv.lock` and `config/provision.lock.json`
retain their original hashes. Root commits after `094c006` contain review data
and evidence only; they do not change the selected build or packing recipes.
