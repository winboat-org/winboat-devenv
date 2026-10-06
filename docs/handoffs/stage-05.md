# Stage 5 handoff

Measured current-host acceptance passed; see
[retained evidence](../evidence/stage-05-acceptance.json) for exact scope and hashes.

Stage 5 implements project client setup, shared Nix/SSH integration, durable
completion, compact evidence and documented contributor/build workflows.
Use [agent workflows](../agents.md) and [configuration](../../config/README.md).
Client versions measured on this host were Codex CLI 0.160.0 and Claude Code
2.1.289. No optional plugin was installed or required.

`wb setup --agents all` merges Codex settings, portable Claude servers, private
Claude timeout settings and generic stdio configuration. Exact changed originals
are retained in private state. Models, approvals, sandbox choices, personal hooks,
disabled servers and per-tool policies remain intact. The TOML parser is locked
through npm integrity metadata and Nix. The genuine Nix and provisioning locks
and all 12 managed source pins are unchanged. Restart/reconnect clients after
configuration or schema changes; the original connection retains its earlier
catalog until reconnected.

SSH keys and host-key pinning already belonged to automatic devbox setup. The
derived private SSH configuration is now created there and refreshed on guest
connections, using the same keys and resolved port. It requires no separate setup
command, global SSH configuration or contributor-specific alias.

The fresh client check uses a copied source workspace with spaces and explicit
read-only reference overrides. It verified Nix and WinBoat initialize/tools-list,
Nix inspection, repository status, guest status and generated Bash refresh.
Codex's real app-server made tool calls without a model turn, using explicit
per-process MCP definitions. Claude's real diagnostics connected both project
servers. No interactive trust UI or Claude model turn was exercised; those are
distinct from the recorded connection/protocol checks. `wb-agents-live` repeats
this measured scope without changing approval policy or user-global settings.

The local suites passed 37 workspace/agent/refresh, 21 devbox and 22 Windows
checks. They include parallel client requests reusing one durable mutation,
scoped local-bare fork/checkpoint/publication, queued-launch recovery, disconnect
durability, preserved original receipts, bounded evidence and native Windows
codes. Publication fixtures do not publish any organization changes.
`devenv test`, formatting and whitespace checks passed.

The runtime workflow built fresh Helios from clean source pins with four Linux
MSVC dependencies, composed a new development package with exact retained
Mesa/CLVK artifacts, installed it, resumed its original transaction after boot,
and passed 13 interactive workloads with 12 mapped DLL identities and actual
resident kernel code. The first
install invocation supplied the outer artifact manifest; preflight refused it
before guest changes. The corrected invocation supplied its bundle manifest.
Package and artifact manifests now have explicit roles in the workflow docs.

The installer returned 3010. Older host job runners exposed truncated Unix 194;
current completion records and observed historical receipts preserve the native
code separately from `processExitCode`, with `reboot-required` state. Historical
evidence is not rewritten. Queued host jobs resume their original ID; completed
failed publication still requires reconciliation.

A normal shutdown exceeded its 120-second deadline and correctly preserved the
guest. It subsequently completed with zero container exit. A proposed SYSTEM
activation reboot failed before submission because SSH had already closed; no
forced reboot or forced container stop executed. The next startup retained the
same guest identity, disk, keys, host artifact and image. The original development
guest and external references remain preserved.

Live full inventory also exposed two Node migration gaps. Repeating full artifact
provenance in every file row produced an 886,701,521-byte inventory, exceeding
Node's string limit. Inventory schema 2 keeps full provenance once and references
retained transaction receipts; its verified result is 8,851,454 bytes. The original
large record remains preserved. The first helper publication/strict-mode failures
are also retained; the shared hash-verified control bundle now includes the helper.
The native kernel observer emits unprefixed hexadecimal pointers. The controller
now validates and parses them without losing 64-bit precision, and unavailable
observations remain unknown. The final registry matched both resident drivers,
all requested package files, DLL mappings and protocol pairing. Its final normal
shutdown completed cleanly with zero exit; the acceptance guest is stopped.

The Stage 4 record remains historical evidence, and the original container
supervisor was retained. This stage does not establish another physical host,
driver conformance, visual acceptance, remote Windows-host support, GitHub fork
publication, or the new supervisor's fresh-container boot. WinBoat/Electron
closures and Stage 6/7 CI, installer and legacy-tool migration retain their scope.
No commits or pushes were requested; existing root changes remain preserved.
