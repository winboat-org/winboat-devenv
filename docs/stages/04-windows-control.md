# Stage 4 — Windows builds, installation and devbox MCP

Status: in progress. Shared task/transfer, source snapshot, DXVK dispatch,
transaction and registry operations passed live CLI/MCP checks, including an
eight-minute SYSTEM job, x64/x86 mapped-DLL replacement detection and reboot
recovery. DXVK x64 built through CLI and x86 through MCP. Complete component and
loaded-stack acceptance remains pending. See [control usage](../windows-control.md)
and [measured evidence](../evidence/stage-04-control.json).
Prerequisites: Stages 2 and 3.

## Outcome

Nix commands build/install the Helios stack through the Windows devbox. The Node
MCP proxies those same operations, and a strict registry reports the exact
requested, installed and loaded identities with recoverable transaction state.

## Implementation

Port behaviors from the existing Rust win-mcp into shared PowerShell payloads
and Nix-declared execution. Keep the MCP implementation in Node. Implement
safe encoded PowerShell arguments, purpose-specific sessions, real exit codes,
hash/size-verified transfers, durable scheduled-task jobs and bounded log reads.
Build/install tasks run under the appropriate elevated principal; desktop tests
refuse session 0 and run as the interactive account. Resolve guest tools from
the provisioning inventory; MSYS2 Git must not shadow native Windows Git.

Complete the Windows backends for KMD SYS/INF/CAT/test signing, UMD11/UMD12,
native DXVK/vkd3d engines, Mesa ICDs, CLVK and loaders, including required x64/x86
variants. Confirm matched SDK/WDK, bindgen layout tests, LLVM/libclang and static
CRT consistency. Keep KMD resource/INF/package versions coherent. Every build
uses a verified local source mirror and returns a complete artifact manifest;
an SSH disconnect must not kill an eight-minute build or hide its failure.

Expose `wb devbox run --purpose ...`, `mirror`, `build`, `install`, `registry
show/verify/reconcile`, job operations and equivalent typed MCP tools. MCP tool
descriptions must make session purpose and evidence requirements clear. General
SSH execution can remain available for development, but declared build/install
operations must use the shared recipes. Clients must not need a second Rust
binary or another set of installation scripts.

Version the registry schema and implement actual discovery of provisioning
tools, KMD package/device/store identities, certificates, UMD11/UMD12, Mesa ICD
registration, x64/x86 loader/DLL locations, CLVK, protocol pairing and active
host QEMU/renderer. Record commit and dirty-source identity, artifact/file hashes,
versions, architecture, operation/provenance, timestamps and verification state.
Verify loaded identities where observable; an overwritten on-disk DLL is not
proof that a running process has loaded its replacement. Restart affected
processes/devices or reboot as required, then observe again.

Installation is a transaction: compatibility preflight, preserved prior state,
verified staging, shared installer execution, resumable reboot handling and
post-install reconciliation. Preserve the existing unattended exit/status
contract and registry snapshot semantics. Failures record exactly what changed
and how to resume/roll back. Unknown manual installs become drift/unknown entries;
do not assign them the requested commit just because their filenames match.

## Acceptance

Build and install the complete selected graphics stack from clean pinned sources
through the CLI, then repeat through MCP using the same recipes. Match receipts,
artifact hashes and observed installed/loaded identities. Verify both x64 and
the declared WoW64 outputs rather than inferring x86 coverage from x64 success.

Run an interactive graphics smoke in the correct session and a durable build/
install fixture as its intended principal. Assert a session-0 desktop invocation
fails clearly. Disconnect/reconnect during build and restart-required installs.
Inject transfer/hash/install failures and verify real errors, partial state,
retained prior inventory and recovery. Alter a fixture DLL/registration manually
and confirm registry reconciliation reports drift.

Keep old win-mcp available until these parity tests pass. Runtime graphics smoke
establishes development-environment acceptance, not full driver conformance.
Document the exact workload, stack identity and any remaining limits.
