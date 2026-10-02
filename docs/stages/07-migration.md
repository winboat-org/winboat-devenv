# Stage 7 — Migration and fresh-host acceptance

Status: planned. Prerequisites: Stages 1–6 and retained replacement evidence.

## Outcome

Environment ownership is consolidated here, redundant Helios tooling is retired,
and a new contributor reproduces the supported workflow from a clean host with
their own Windows ISO and fork namespace.

## Implementation

Inventory Helios submodules, win-mcp, installer/package tooling, devbox launchers
and non-component scripts/docs. Classify ownership by actual function. Preserve
driver/project internals in Helios and component repositories; move environment,
shared operations and personal machine material to the documented destinations.
Retain licenses/attribution/history and update links/call sites/CI consumers.

Remove Rust win-mcp only after Node CLI/MCP parity, Windows purpose/session tests,
installation transactions and recovery pass. Relocate environment launch scripts
after the headless container/viewer and generic configuration replace them. The
old installer is removed only after bundle/install/update/uninstall parity.
Do not retire a reference implementation solely because a replacement builds.

Flatten former Helios submodules where the independent workspace tool replaces
them, version the layout and update standalone build interfaces. DXIL-SPIRV
remains a managed vkd3d dependency; establish the requested **Venus submodule in
Mesa**, update renderer/protocol consumers and reconcile any old Helios gitlink.
Preserve paired protocol generation and pin consistency. A layout migration
plans moves/adoptions, preserves dirty work and offers recovery; do not delete a
working checkout or duplicate writable copies. Publish child/layout changes in
dependency order and verify every pinned commit is reachable.

Generalize setup/docs after testing them on another path/user and host stack.
Document supported host capabilities and precise prerequisites, user-provided
media/download identities, optional viewer backend, remote-host support and
known gaps. Never copy the old owner's paths/users into onboarding. Personal
notes remain ignored under `docs/user/`; common procedures are generalized here.

## Acceptance

On a clean supported Linux machine or isolated equivalent, install Nix/devenv,
enter the locked environment, run setup/doctor, sync each subset and create a
contributor fork workspace. Build the native stack and create the devbox from
user-supplied media without GUI intervention. Build/install guest artifacts,
reconcile loaded registry identities and run a correctly scoped desktop smoke.

Use both CLI and MCP, attach/close the viewer, disconnect/reconnect a long build,
restart the container and reconcile its retained state. Build a bundle using
published component artifacts with no compilation in root CI. Repeat from a
different path/username and check relocation/port/state isolation.

Audit root/nested staged diffs for personal docs, keys, ISO/disks, absolute host
paths and unrelated work. Confirm the old tooling is no longer referenced and
project docs remain in their owning repos. Record exactly which fresh-host/live
CI/runtime checks passed and any limits; only then mark migration accepted.
