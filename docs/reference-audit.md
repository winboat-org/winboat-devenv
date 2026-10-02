# Reference audit

Read-only audit on 2026-10-02 of the supplied local Helios checkout at
`52c02799a042ecab25b9e812db9c002ba98ddb7c`. No source changes, deployment or
live `ssh win` inspection were performed. Host-specific values in that checkout
are references to investigate, not defaults for this workspace.

| Reference at the Helios snapshot | Reusable behavior |
| --- | --- |
| [win-mcp README](https://github.com/winboat-org/helios/blob/52c02799a042ecab25b9e812db9c002ba98ddb7c/tools/win-mcp/README.md) and `src/{main,host,cli}.rs` | Shared CLI/MCP operations, execution purposes, detached scheduled tasks, PowerShell encoding, hash-verified transfers, local mirror |
| [QEMU launcher](https://github.com/winboat-org/helios/blob/52c02799a042ecab25b9e812db9c002ba98ddb7c/tools/launch-helios-gtk.sh) | Firmware, disk/NVRAM/TPM state, display transports, QEMU data/module paths, user networking and ISO attachment |
| [TOOLCHAIN.md](https://github.com/winboat-org/helios/blob/52c02799a042ecab25b9e812db9c002ba98ddb7c/TOOLCHAIN.md) and `tools/build-native-renderer.sh` | Paired Venus/renderer builds, generated Mesa headers, local Windows Cargo artifacts, current compiler/SDK constraints |
| [Installer README](https://github.com/winboat-org/helios/blob/52c02799a042ecab25b9e812db9c002ba98ddb7c/installer/README.md) and `packaging/windows/` | Shared PowerShell install payload, self-contained archive, silent operation, restart/resume state and retained registry snapshots |
| [Existing CI](https://github.com/winboat-org/helios/blob/52c02799a042ecab25b9e812db9c002ba98ddb7c/.github/workflows/windows-stack.yml) and `ci/windows/` | x64/x86 builds, component artifacts, tool versions, installer build and package assembly |
| `.gitmodules` and nested Git trees | Seed SHA relationships, DXIL-SPIRV parent, current Venus layout and selective submodule requirements |

The launcher is named GTK but supports SDL; it is not a generic container
definition. Existing code contains contributor-specific paths, users, interfaces
and device assumptions that must become discovery/configuration. QEMU modules
and executable must come from one build; carry matching data/firmware paths.
The requested bootstrap device is `virtio-vga-gl`, replacing the reference
launcher's bootstrap-display choice for the new devbox.

The snapshot's build CI declares LLVM 22.1.8, Vulkan SDK 1.4.350.0,
Rust nightly-2026-07-14, Meson 1.11.2 and pinned helper versions. TOOLCHAIN lists
matched SDK/WDK 10.0.26100.0 and warns against an incomplete newer kit winning
automatic selection. These are seed observations: Stage 2/3 must reconcile
actual build recipes and lock verified installer identities. Bindgen 0.72 and
native static-CRT ABI requirements must be preserved unless validated changes
deliberately update them. Do not inherit stale host defaults from old prose.

The installer writes provisioning states including test-signing restart required,
driver restart required, finished and failed. It returns 3010 when a reboot is
required and uses an appended, hashed payload archive. Migration must preserve
these consumer-visible contracts and use one install payload across CLI/MCP.

The local WinBoat reference is `gpu-accel` at
`17563cacb82ca31efe5feb12e3968f51951f1085`. The inspected Helios tree stores Venus
as its own top-level submodule and copies generated driver headers into Mesa;
Mesa does not have the requested Venus submodule at this snapshot.

Upstream implementation references were opened for [devenv bootstrap](https://devenv.sh/getting-started/),
[devenv input configuration](https://devenv.sh/reference/yaml-options/),
[Dockur unattended/custom-ISO provisioning](https://github.com/dockur/windows),
[Windows test signing](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/the-testsigning-boot-configuration-option),
[Codex MCP](https://developers.openai.com/codex/mcp/) and
[Claude Code MCP](https://code.claude.com/docs/en/mcp). Dockur supports local ISO
and OEM provisioning scripts; assess a pinned base or reusable installation
logic, then substitute the Helios QEMU output. That reference is not proof of
compatibility with our fork, GPU access, SDL attachment or chosen toolchain.

This session ran `devenv init --include-envrc`. After redirecting devenv's
read-only home/runtime state into ignored workspace state, `devenv update`
reached input fetching but failed on DNS. Git remote lookup also encountered
host URL rewrites/SSH configuration restrictions. No lockfile was fabricated.
Stage 1 must retry in a network-capable session and report shell/runtime
acceptance separately from pure manifest validation.

The owner initialized the root Git repository after the first init attempt.
Git subsequently recognized it, but the session still mounted its metadata
read-only (`.git/index.lock` could not be created). The initial scaffold commit
is therefore prepared in a separate writable temporary checkout and exported
as a local Git bundle. This is a session constraint, not a development-environment
requirement; normal Stage 1 operation expects writable Git metadata.
