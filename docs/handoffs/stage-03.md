# Stage 3 handoff prompt

Stage 2 supplies native QEMU/renderer/Venus artifacts and shared build operations.
[Validation](../validation.md) separates measured checks from pending hardware,
Windows and publication checks. Recipe commits and matching pins are local only.
Paste this into the next session:

```text
Implement Stage 3 of winboat-devenv through docs/stages/03-devbox.md.

Read AGENTS.md, README.md, docs/architecture.md, docs/repositories.md,
docs/workspace.md, docs/builds.md, docs/validation.md and the stage index/spec.
Inventory root and all managed/nested Git status before edits or commits.
Preserve unrelated changes, external reference checkouts and existing VMs.
Use the unchanged genuine devenv.lock and locked shell for routine execution.
Do not refresh inputs or recursively initialize QEMU submodules.

Reuse nix/build*.nix, nix/dispatch.nix, nix/host-smoke.nix and component
nix/default.nix interfaces. Python records snapshots/artifacts; compilers and
payload contracts remain Nix-defined. Node MCP is the typed proxy for the same
wb application. Reuse JSON receipts and durable jobs. Do not duplicate lifecycle
logic in Node or alter client approval settings.

Use the exact host-stack manifest and retained Nix closure, including QEMU,
matching modules, firmware/data, renderer/server, generated headers, symbols,
licenses and validation report. Copying only files/ does not transfer store
dependencies. Container import must preserve the manifest-selected closure and
prove executable and loaded renderer/module identities. Do not substitute
distribution QEMU or host-installed renderer/firmware.

The CPU smoke exercises SDL's dummy driver and QMP with no installed guest.
It proves module/frontend integrity, not hardware Vulkan or interactive SDL.
Perform Stage 3 hardware/VM checks with discovered capabilities and retain
failures accurately. KVM/device permissions, display sockets and container
runtime are local capabilities, with no hardcoded GPU node, bridge or username.
All 16 QEMU gitlinks and LookingGlass remain uninitialized. Required wraps and
Vulkan headers are supplied from locked Nix inputs.

Six recipe commits and updated Helios parent gitlinks/pins are unpublished.
Ignored local.json workspace.remotes overrides point to managed clones for
verification; canonical URLs remain unchanged. Do not claim fresh remote
reproducibility. Transfer local repositories if needed. Do not push unless
separately requested; authorized publication uses wb repo push, children before
parents, then reconciles receipts/pins. Preserve unchanged DXIL-SPIRV/Venus pins.

Obtain the user-supplied Windows ISO and verify hash/edition before provisioning.
Discover or validate container runtime and device permissions. Keep media,
credentials, SSH keys, guest disks and personal machine notes ignored. Implement
isolated persistent state, headless unattended provisioning, durable phase/reboot
resume, guarded workspace sharing and local source mirrors. Guest defaults stay
wbdev, WB-DEVBOX, Z:\ share, C:\WinBoatDev\src mirror and C:\WinBoatDev\build
output root. Never compile on the share or replace an unrelated existing VM.

Provision exact tools from verified inputs: matched SDK/WDK, LLVM/MSVC, Rust,
OpenSSH, PowerShell and Meson/Ninja. Stage 2 plans are not executed guest builds.
Windows build/install/loaded-state acceptance is Stage 4. WinBoat/Electron/CLVK
still need fixed dependency closures. Retain Helios' protocol license notice.

Keep headless lifecycle independent of the viewer. Prove attach/close without
killing the VM; QEMU SDL cannot be advertised as hot attach without evidence.
Document any separate attachable viewer and restart constraints. Support
headless hosts without display sockets.

Run Stage 3 acceptance and devenv test. Retain artifact/lifecycle evidence,
update stage status/docs and commit small validated local checkpoints with
explicit task-owned paths. Do not build an installer in root release CI, replace
old win-mcp, remove submodules or alter external reference tooling. Provide a
Stage 4 handoff with remaining SDK/hardware/media checks stated precisely.
```
