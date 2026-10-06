# Agent workflows

Stage 5 uses the same Nix-packaged operations as terminal and CI users. Enter
the trusted checkout with its existing native devenv activation, then run:

```sh
wb setup --agents all
```

Select `codex`, `claude` or `mcp` for one client. MCP `workspace_setup` accepts
the same `agents` selection. No client installation or account login is performed.
Restart the selected client after setup and handle its normal checkout/server
trust prompts. Reconnect existing MCP processes after changing Nix execution
definitions or tool schemas; command refresh does not update running servers.

Codex settings merge into ignored `.codex/config.toml`. Claude's portable server
definitions merge into `.mcp.json`, with timeout/output settings in ignored
`.claude/settings.local.json`. Other clients can import the absolute stdio
definitions in private `<state-root>/agents/mcp.json`. Shared Claude definitions
resolve `wb` and `devenv` from the locked PATH. Codex and generic definitions use
Nix store launchers and explicit workspace arguments, including paths with spaces.
Regenerate after moving the checkout or changing its Nix closure.

Existing models, approvals, sandbox choices, disabled servers, per-tool policies,
unrelated servers and personal hooks survive setup. Managed launcher commands and
timeouts are refreshed. Codex requires its existing Bash refresh integration;
a conflicting personal `BASH_ENV` is refused for explicit integration. TOML is
normalized, including removal of comments; exact changed originals are backed up
privately under `<state-root>/agents/backups/<operation-id>/`. All selected merges
are validated before any client config is written, and a shared lock serializes
concurrent setup. No user-global settings are written.

`wb-codex-config` still renders the same configuration for manual inspection;
`wb agents config --client codex|claude|mcp --json` returns rendered content.
No plugin is required: devenv's existing MCP supplies Nix inspection and the
workspace's Nix-pinned OpenSSH supplies authenticated Windows transport.
Optional account/plugin failures do not prevent `wb setup` or either core server.
The TOML parser is pinned in the npm lock and installed through Nix.

Configuration formats were checked against the official
[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Claude MCP documentation](https://code.claude.com/docs/en/mcp).
Claude uses a 120-second startup environment timeout and 60-second per-server
tool timeout; Codex sets both server startup and tool timeouts explicitly.

## Jobs and evidence

Discover the connected schemas before invoking tools. Background-capable tools
return host `jobId` handles; a direct `devbox_run` returns a Windows task operation
ID. Wait with `job_wait` for host orchestration, or `devbox_job_wait` with the same
guest name for Windows tasks. CLI equivalents are:

```sh
wb job wait --id <host-job-id> --timeout 45 --json
wb devbox job wait --name <guest> --id <windows-task-id> --timeout 45 --json
wb job logs --id <host-job-id> --offset 0 --limit 8192 --json
```

Waits are bounded to 50 seconds. `terminal: false` and `timedOut: true` preserve
the job and its ID. Continue waiting on that handle; do not start another build.
Detached workers and Windows scheduled tasks survive client disconnects. Native
failure and reboot codes remain in JSON, including 3010. Queued host jobs can
resume using their original ID after an interrupted launch; claim locks prevent
duplicate runners. Publication recovery still requires its recorded reconciliation.

For retriable background submissions, supply a stable MCP `requestId` or CLI
`--request-id <unique-request>`. Concurrent retries with identical operation
arguments reuse one durable job. Reusing that ID with different arguments fails.
Use a new ID for a new operation; omitting it intentionally starts a new job.
The mapping is retained before spawning the worker, under the same request lock.

MCP compacts receipts above 16,000 bytes and retains the complete result in private
state. The reply's `fullResult.id` addresses `evidence_read`; CLI
`wb evidence --id <id> --offset 0 --limit 8192 --json` reads the same bounded page.
Offsets/counts are bytes, and pages expose `nextOffset` and `eof`. Reads are scoped
to retained MCP receipts and job logs by validated IDs, with a 16 KiB page maximum;
they cannot address arbitrary credentials or guest-state paths. Normal CLI JSON
remains complete unless `--compact` is requested. Tool discovery contains schemas
and descriptions, never entire build logs.

## Contributor workflow

Inspect root and selected nested changes before edits. Preserve dirty work and
external checkouts. Use local overrides to adopt references explicitly; a copied
Git checkout alone does not migrate assets, keys, guest state or build artifacts.

1. Run `workspace_status`, `repo_status` and `repo_plan` for the intended subset.
2. Run `repo_fork` with the contributor's namespace to validate existing forks;
   use `apply: true` to select them. It retains canonical `upstream` and writes
   only ignored local configuration. Fork creation/account credentials are external.
3. Run `repo_sync` for the selection and wait for completion. Dirty affected
   repositories are refused without reset, stash or cleanup.
4. Use `repo_branch` for one repository, make scoped edits, validate through its
   component commands, then `repo_checkpoint` with explicit task-owned paths.
5. When publication is authorized, run `repo_push` in dependency order. It verifies
   the actual remote revision before advancing parent gitlinks and root pins.
   Reconcile a retained publication receipt after interruption. Push only when asked.

The [CLI equivalents](workspace.md) support the same workflow. Component internals
belong in their repositories; shared environment/workflow docs belong here.

## Build, install and inspect

1. Inspect `build_list` and select an exact target and source mode. Windows
   dependencies cross-compile on Linux; `helios-guest-x64` retains its documented
   pinned WDK build limitation. Use a named verified guest for that target.
2. Start `build_run` or `devbox_build`, retain its handle, wait, then verify its
   exact exported manifest with `build_verify`. Release requires clean pinned
   sources; development builds retain captured diff identities.
3. Compose `helios-development-package` using explicit verified dependency
   manifests. This produces the existing development package and preserves
   licenses/provenance; it does not implement Stage 6 release assembly.
4. Run `devbox_install` with `files/bundle/manifest.json` inside that verified
   package artifact (the outer artifact manifest is for `build_verify`), wait for its host job,
   and use the returned original transaction ID for reboot/resume when required.
5. Run `devbox_registry_verify`, then `devbox_smoke` with that installation
   transaction. Completion must match installed files, resident kernel/DLL code
   and interactive workloads. A build, copy, installer exit or reboot proves
   only its own step. Opening the viewer is optional.

Guest setup already creates private client/host keys and pins the host key. It
also derives `<state-root>/devboxes/<name>/ssh/config` automatically; guest
connections refresh it when needed. No SSH key/config command or host alias is
required. Builds/installs run as durable SYSTEM tasks. Desktop probes require the
interactive `wbdev` session. Raw SSH with the generated config is a diagnostic
option; normal work uses `devbox_run` purpose semantics and verified transfers.
Remote Windows hosts remain outside the measured local-devbox contract.

See [Windows control](windows-control.md), [builds](builds.md) and
[devbox usage](devbox.md) for artifact, mirror, signing and recovery details.
Stage 6 owns component CI, prebuilt installer acquisition and release bundling;
Stage 5 does not remove legacy installers, win-mcp or submodules.

## Repeat the client check

`wb-agents-live --name <guest> --state-root <state-root>` copies current tracked
and nonignored source files into an isolated workspace path containing spaces,
adopts selected repositories read-only, generates configuration and exercises
fresh stdio MCP initialization, tool discovery, Nix inspection and guest status.
It launches Codex's app-server without a model turn or policy changes and checks
Claude's actual connection diagnostics. Exact client versions and retained
results go under ignored `.state/stage05/`. Existing clients and unrelated
configured servers are preserved. Interactive client trust and model-driven
workflow behavior are separate from these programmatic checks.
