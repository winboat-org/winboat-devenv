# Stage 3 — Headless Windows development container

Status: current-host Podman acceptance passed, including private NVIDIA CDI,
blank-disk provisioning, all 14 tools, autologin, signing/driver load and local
mirror/build/hash return. Docker's initial full guest checks passed; its repeat
with the corrected QEMU artifact is blocked by daemon image-store space.
Alternate UID preparation passed; Windows boot under another host account and
another physical host remain unvalidated. See
[usage](../devbox.md) and [validation](../validation.md).
Prerequisite: Stage 2's host QEMU/renderer outputs.

## Outcome

One command provisions a headless Windows VM in a pinned container from the
user's ISO. It has deterministic guest identity, the locked development tools,
test signing, SSH, the workspace share/local mirror, recoverable provisioning,
automatic desktop login and an optional attachable viewer.

## Implementation

1. Evaluate a pinned Dockur/helios-windows base or reuse its unattended/OEM
   installation logic. Lock the base image/source digest, replace QEMU with the
   complete Stage 2 fork output and verify the launched executable/modules.
   Implement Docker/Podman selection through capability checks and overrides;
   do not assume a daemon, host network bridge, distro firmware or rootless GPU
   access. The doctor must explain KVM, render-node and runtime requirements.
2. `wb devbox create --iso <path>` validates and records the supplied ISO hash,
   edition/index, locale and provision lock. Enterprise is preferred; require an
   explicit compatible edition/index if it differs. Do not fetch Windows media
   silently. Generate unattended media for `wbdev` / `WB-DEVBOX`, local secrets,
   keys and credentials. Use the initial **virtio-vga-gl** device, persistent
   disk/NVRAM/TPM state, Nix-supplied firmware and headless display/networking.
   Windows media/images remain ignored local inputs.
   Persist automatic `wbdev` login across later identity/signing reboots using
   the Winlogon LSA secret, remove the initial count limit/plaintext registry
   password and prevent generated account password expiry. Verify the actual
   interactive user/session after reboot; provisioning belongs to SYSTEM.
3. Track provisioning phases, durable task IDs, retries, reboot count and
   failure evidence. Interrupt/reconnect must resume the known phase; never
   overwrite an existing guest disk on retry. Implement `create`, `up`, `down`,
   `restart`, `status`, `logs` and an explicit guarded `destroy` path. SSH ports
   are discovered/allocated and persisted; known-host/key state is workspace
   local. Do not depend on the reference machine's `ssh win` alias.
4. Create a tracked provisioning lock with exact installer version/source/hash,
   install flags and component IDs for VS Build Tools/MSVC, matched SDK/WDK,
   LLVM/libclang, Rust nightly/targets/rust-src, cargo helpers, Git, OpenSSH,
   PowerShell, Python, Meson/Ninja, Vulkan/shader tools and needed kernel-debug
   tools. Reconcile the reference CI/toolchain before fixing versions. A
   bootstrapper or winget package name alone is not a lock: retain/verify the
   selected channel manifest and installed component versions. Avoid incomplete
   higher Windows kits taking precedence over the matched SDK/WDK.
5. Enable test signing from automation, configure guest Secure Boot policy to
   permit it, install a generated test certificate, reboot and verify effective
   BCD/signing state. Install a test-signed driver fixture and verify it loads.
   Preserve certificate identity for later packages; HVCI/signature policy must
   be discovered and reported. Do not equate unsigned-driver installation with
   a test-signed driver loading. [Microsoft's test-signing requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/the-testsigning-boot-configuration-option)
   govern the reboot and signature checks.
6. Expose the whole workspace at the defined guest share and provide a robust
   local mirror to `C:\WinBoatDev\src`. Use robocopy with bounded retries,
   junction/output/secret exclusions and explicit destination guards. Treat
   0–7 as success and 8+ as failure; record source snapshot/diff hashes. Build
   outputs/Cargo targets remain on the guest local disk, outside mirrored
   sources. Share mechanism is chosen after a compatibility probe; it must not
   require mounting a contributor's whole home directory.
7. Provide `viewer open/close/status` without stopping the VM. Prefer a separate
   SDL viewer and prove its transport against the headless QEMU instance.
   Investigate whether the fork supports hot display changes; a local QEMU SDL
   window cannot simply be promised as a detachable viewer. If a separate SDL
   client is unavailable, document and validate an attachable fallback with the
   reason and later SDL work recorded. Detect display availability and support
   headless hosts; never assume Wayland/X11 sockets or reuse another VM's ports.
8. Persist a strict provisioning-tool inventory with actual installed versions,
   installer hashes, component IDs and verification results. Write host/guest
   observations separately; carry this baseline into Stage 4's stack registry.
   Expose lifecycle/status/jobs through the existing Node MCP command proxy.

## Acceptance

With supplied media, create a fresh guest without interactive installation.
Verify guest identity, post-reboot desktop autologin, SSH key authentication,
installed SDK/WDK/compiler/tool versions, effective test signing after reboot,
signed-driver load and fork QEMU
identity. A missing ISO leaves this live gate pending rather than accepted.

Mirror a small workspace fixture, build on local Windows disk, return a
hash-verified output, and ensure ignored secrets/build outputs are excluded.
Interrupt provisioning around download/install/reboot boundaries and prove
idempotent resume. Start/close the viewer twice while confirming the VM process
and a long guest job survive. Record the backend actually tested.

Relocate the root path and exercise a different host username/configuration.
Check two devboxes do not collide in ports or state. Missing GPU/KVM/runtime/
display capabilities need actionable errors; no host package installation or
system configuration is a hidden shell-entry side effect.
