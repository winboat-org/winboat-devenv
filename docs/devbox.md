# Windows devbox

Stage 3 supplies the shared CLI/MCP lifecycle, a Nix-built container image and
Windows provisioning payloads. Current-host blank-disk creation, automatic desktop
login and container/QEMU/tool/signing/mirror checks passed.
Consult [validation](validation.md) and the [provisioning lock](../config/provision.lock.json)
before treating a guest as ready for Stage 4.

All 14 tools have fixed publisher inputs. The Nix container build prefetches the
complete SDK/WDK installer layouts, self-contained Microsoft EWDK, LLVM, dated
Rust distribution and targets, cargo helpers, Git, OpenSSH, PowerShell, Python,
Meson, Ninja and the Vulkan core installer. It exposes these immutable files
through an authenticated read-only tools share. The Windows SYSTEM task copies
each input to local disk, rechecks its hash, installs it and probes its actual
version. The running task refreshes the machine `PATH` before each next tool,
so newly installed dependencies are available in the same provisioning run.
No guest tool acquisition is deferred to winget or a mutable channel.

The EWDK is expanded in full at `C:\WinBoatDev\tools\EWDK`, including its
licenses and build environment. `WINBOAT_EWDK_ROOT` and `WINBOAT_VS_ROOT` identify
that portable installation; builds call `BuildEnv\SetupBuildEnv.cmd` rather than
assuming installer registration in vswhere. The separate SDK/WDK install uses
kit directories `10.0.26100.0`; their QFE package versions are recorded separately.
Vulkan installs its offline core with LunarG's Qt installer command. Rust installs
from verified archives served on guest loopback, preserving both source and
relocated manifest hashes.

```sh
devenv shell -- wb devbox capabilities --json
devenv shell -- wb devbox media --iso /path/to/windows.iso --json
devenv shell -- wb devbox create --name development --iso /path/to/windows.iso \
  --manifest out/native/<exact-operation>/manifest.json --start --background --json
devenv shell -- wb job status --id <returned-job-id> --json
devenv shell -- wb devbox status --name development --json
devenv shell -- wb devbox logs --name development --json
devenv shell -- wb devbox guest-status --name development --json
devenv shell -- wb devbox viewer open --name development
devenv shell -- wb devbox viewer close --name development
devenv shell -- wb devbox down --name development --background --json
```

`create` prepares persistent state; `--start` also launches the VM. A successful
`up` job proves the requested container and QEMU startup/loaded-image checks.
It does not mean Windows provisioning succeeded. `guest-status` separately reads
the guest's durable inventory over key-authenticated SSH. Its `verified` phase
requires the tool probes, a signing reboot, effective BCD and signed fixture load.
An incomplete provision lock or failed native installer cannot produce that phase.

The default image selection prefers Enterprise/EnterpriseS. `--edition` or
`devbox.edition` selects an exact edition ID; non-Enterprise selection also
requires an explicit image index.

Select an exact `host-stack` manifest explicitly or in ignored
`devbox.hostManifest`; there is no latest-run search. Artifact hashes, symbols,
licenses, smoke evidence, the unchanged Nix lock and every recorded closure NAR
identity are checked. The image uses `builtins.storePath` for the complete output:
QEMU, modules, firmware/data, paired renderer/server, headers, symbols and licenses
remain in their immutable store paths. Nix's locked inputs supply the container's
other tools and Mesa userspace. There is no distribution QEMU or mutable base tag.
The unattended answer-file/first-logon approach assessed in Dockur is implemented
here using [Microsoft's answer-file contract](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/automate-windows-setup?view=windows-11).

Image archives have retained Nix roots and recorded SHA-256/image/derivation
identities. Podman accepts only the selected local archive through a Nix-declared
signature policy; default transports are rejected and VM runs use `--pull=never`.
The container records `/proc` executable and renderer/module paths and hashes,
compares them with the selected artifact and requires QMP readiness. Desired,
built image, running container, observed host images and guest inventory stay
separate. These checks establish EGL/QEMU startup, not a guest Vulkan workload.

The runtime is selected by a bounded Docker/Podman capability probe. The locked
Podman client uses workspace-local storage/run state with the VFS storage driver;
it needs the host's existing user-namespace/subuid/subgid support. An explicit
`containerRuntime` and `runtimeCommand` argument array can select an already
configured runtime. No command installs host packages or changes groups, daemon
configuration, bridges or desktop configuration. With multiple accessible GPUs,
choose `devbox.renderNode` explicitly from the reported nodes. Device access is
distinct from working graphics userspace; the current image's Mesa path was
tested on Intel, and proprietary driver/CDI integration remains unvalidated.

Each named devbox has its own generated ownership identity, disk, secure-capable
Nix firmware with unenrolled Secure Boot keys, persistent NVRAM/TPM, credentials, SSH keys, host key and loopback SSH/VNC
ports under `.state/devboxes/`. Initial creation journals ownership before
side effects and retries preserve its keys, disk and NVRAM. Existing unrecognized
directories are refused. The initial installation boot alone uses the CD-first
boot and automatic boot-key delivery; later starts use the persistent disk.
Windows phase/retry/reboot state lives under `%ProgramData%\WinBoatDev\` and a
SYSTEM scheduled task continues across logouts/reboots. It checks the actual
CIM computer name and corrects/reboots a Setup identity mismatch with bounded
retries before installing tools. Live cache-copy and EWDK install interruptions
preserved identity/keys and resumed; the signing reboot reached a running signed
driver. An EWDK completion marker is written only after full extraction, so a
partial compiler tree cannot pass its probe. Native process logs and earlier
failure records are retained; state replacement retries concurrent reader locks.
The `wbdev` desktop logs in automatically after each boot, including identity
and signing reboots. Bootstrap stores its generated password in the Windows LSA
secret used by Winlogon, removes the initial login-count limit and plaintext
Winlogon password, and updates the login domain when the computer is renamed.
The generated local account password does not expire, so automatic login and
its private SMB credential remain usable across later boots.
Provisioning still runs in its durable SYSTEM task independently of the desktop.
Hybrid shutdown is disabled so startup-task recovery gets a full boot. Cache
connection attempts are bounded while the guest network starts. SMB credentials
use the explicit `WORKGROUP\wbdev` server identity; unqualified usernames caused
Windows error 1312 in the measured compatibility probe. Drive mappings are
created in the task or mirror caller's logon session as needed.

The account/computer/share/source/build contracts are `wbdev`, `WB-DEVBOX`,
`Z:\`, `C:\WinBoatDev\src` and `C:\WinBoatDev\build`. Generated answer media
contains secrets and stays in private ignored state. The pre-generated guest SSH
host key is installed by provisioning and its public identity is pinned locally;
SSH never accepts an unknown key or uses a reference-machine alias.

The workspace bind mount and authenticated SMB share are read-only. Samba vetoes
state, Git metadata, agent config, build outputs, local settings, secret/media
file patterns and symlink following. Personal `docs/user/` is masked by an empty
mount. The Windows mirror helper guards source/destination boundaries and its
ownership marker, excludes secrets/output/junction paths, limits robocopy retries,
accepts statuses 0–7 and verifies each returned file against its shared source.
Source snapshot/diff identities and local Cargo/build roots are retained in its
receipt. The mirror authenticates the workspace UNC in the caller's logon session;
SYSTEM's visible `Z:` link alone does not provide SSH-session credentials. The
live fixture was mirrored, compiled/signed on local Windows disk and returned by
SFTP with matching hashes. Stage 4 must bind component source identities and
execute component builds in durable elevated tasks.

The attachable fallback is the locked **TigerVNC** client against QEMU's VNC
transport and EGL headless backend. It is a separate process. Closing it leaves
the VM running, and no display socket is mounted into the VM container. QEMU's
local SDL frontend is tied to QEMU's process lifetime and is not advertised as
hot attachable. A separate SDL client/transport remains future work. Headless
hosts can operate the VM without opening a viewer.

`down` requests ACPI shutdown through QMP and preserves a VM that does not shut
down in time. `down --force` explicitly terminates it and records an unclean
shutdown. `restart` uses the clean path. To select updated container supervision
code, first stop the guest and run `up --rebuild-image`; prior image archives are
retained, and rebuilding a running VM is refused. Existing devboxes retain their
prepared Windows payload/lock; changing the repository lock does not silently
rewrite them. A new named guest is currently required for a changed guest lock.

`destroy --confirm <identity-from-status>` permanently deletes only a stopped,
owned named devbox after checking its state boundary and container labels.
Runtime images and shared source/media caches are retained. No lifecycle command
controls unrelated containers or existing VMs.
