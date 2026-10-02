# Workspace control plane

Stage 1 supplies `wb` and a shell-scoped Git wrapper from
`nix/commands/repos.nix`. Python implements the shared operations; Node validates
MCP arguments and invokes that same Nix application with argument arrays. No npm
installation is needed. The Nix lock supplies Node, Python, Git and devenv.

## Prepare and inspect

```sh
devenv shell
wb setup
wb doctor --json
wb repo list --subset helios
wb repo status --repo qemu-helios
wb repo plan --repo qemu-helios
wb repo verify --subset all --background --json
```

`setup` creates ignored local configuration/state idempotently. Shell entry,
list, status and plan do not clone, commit, start a VM or install host packages.
Doctor reports capabilities, hook/trust diagnostics and source evidence; use
`--remote` for a new remote check. KVM/container/display observations are separate
from Stage 3 VM readiness.

Root discovery walks upward for this repository's Nix inventory and shell.
`--workspace` overrides discovery; the shell's `WB_WORKSPACE_ROOT` is a fallback
for commands invoked elsewhere. Paths containing spaces are supported. Settings
merge tracked `config/defaults.json`, ignored `local.json`, and explicit
`--repositories-root`, `--state-root`, `--out-root` arguments. Output/state/source
roots must be disjoint and cannot contain the workspace. Changing layout or
schema versions requires an explicit migration.

Selections accept `--subset helios|winboat|winboat-accel|all` and repeated
`--repo <id>`, or both. No selector means all. Dependencies are included once;
required parent containers appear separately in plans. `clkvk-helios` aliases
`clvk-helios`. Branch/pin changes require exactly one explicit repository.

## Sync and develop

```sh
wb repo plan --subset helios
wb repo sync --subset helios --background --json
wb job status --id <job-id> --json
wb repo branch --repo winboat --name local-development
```

Sync fetches exact objects into ignored caches and validates parent gitlinks
before materializing managed trees. On a new workspace that validation needs
cached remote metadata; the plan lists those state writes. It never substitutes
remote HEAD for a missing pin. Checkouts begin detached. A development branch
that differs from its pin must be published or explicitly detached before sync.

Affected dirty, staged, untracked and conflicted work is refused. Unselected
work and parent containers already at their pin are preserved. Changing a parent
with dirty submodules is also refused. Only declared third-party submodule paths
are initialized; managed children have their own exact pins. QEMU has an empty
allowlist and LookingGlass remains outside the selection. No recursive QEMU
update is used.

Existing external checkouts require explicit local `repositoryOverrides` with
`path`, `adopt: true` and optionally `readOnly: true`. Nested overrides must keep
the declared parent layout. Ownership and remotes are checked before mutation.
Read-only references can be inspected but cannot be synced, committed or pushed.

## Scoped checkpoints and publication

```sh
wb repo checkpoint --repo winboat --path src/example.ts --message 'feat: example'
wb repo checkpoint --repo helios --path venus-protocol:source-file.xml --message 'fix: protocol'
wb repo push --repo winboat --remote origin --source HEAD --json
```

Checkpoint paths are explicit files, including tracked deletions, relative to
each selected repository. `id:path` limits a path to one member of a selection.
Directories and blanket `.` scopes are refused. Changes are committed in child
order; authorized parent gitlinks get scoped local commits. Unrelated staged
entries stay staged. Source pins advance after verified publication, so local
checkpoints retain a required external publication step in their receipt.

The shell's `git push` delegates to absolute Nix Git after a porcelain dry-run
preflight. Ordinary Git commands retain their arguments and output. Global
`-C`, `-c`, git-dir and work-tree options remain effective. After success, the
wrapper reads the remote development ref and records the exact pushed source
commit, which can differ from checkout HEAD. Tags, deletes, unrelated branches,
dry runs and failed pushes do not advance pins. No-op pushes verify remote state
and avoid an empty checkpoint.

`--all`, `--mirror`, `--prune`, multiple push destinations and ambiguous pin
effects are refused before publication. Use `wb repo push` with explicit
repository/remote/source arguments. A single alternate push URL is supported
when it matches the explicitly pinned source URL. Absolute Git binaries and
clients with their own Git can bypass interception: configure them to use the
shell wrapper or use `wb repo push`. No global Git config or hooks are installed.

Pin writers serialize and compare expected revisions. A literal-data parser
rejects executable Nix expressions/interpolation. Atomic writes merge only the
operation's fields. Root commits use an isolated index and HEAD compare-and-swap;
the normal Git index is locked while its selected entries are merged. Unrelated
working/staged pin fields, even in the same file, stay outside the checkpoint.

Child publication updates its parent's gitlink locally and records
`pendingParents`; it does not claim the parent is remotely published. Publish
children before parents. Parent publication checks all managed child gitlinks
against their current pins and marks matching retained receipts published.
During a multi-step transaction, temporary pin/gitlink inconsistency makes sync
refuse until the coherent parent is published. Distributed pushes are not atomic.

```sh
wb repo push --repo venus-protocol --defer-checkpoint
wb repo push --repo helios
wb repo reconcile --operation <deferred-operation-id>
```

Deferred mode updates working pins while postponing the root checkpoint. Each
deferred receipt must be reconciled explicitly after the parent publication.
A successful remote push followed by a local write/commit failure returns a
partial-completion error with an operation ID. `reconcile` verifies that exact
remote SHA and finishes local work without pushing again. A moved remote or
competing pin update is refused. Receipts live in `.state/operations/`.

Explicit refresh is separate from sync:

```sh
wb repo pin --repo winboat --rev <40-character-sha> --ref refs/heads/main
```

It fetches/verifies that object before checkpointing. Nested pins must agree
with the pinned parent gitlink; publish coherent child/parent changes through
the publication tool.

## Contributor forks

```sh
wb repo fork --subset winboat --namespace contributor
wb repo fork --subset winboat --namespace contributor --apply
```

Fork mode validates access and local pinned objects for the whole selection
before changing any selected remotes. It keeps canonical winboat-org `upstream`,
changes only selected `origin` URLs, and updates nested URL overrides in local
Git config. Existing conflicting upstream/multiple origin/pushurl settings are
refused. It leaves `.gitmodules`, exact pins and global Git/SSH configuration
alone. Missing forks include an explicit `gh repo fork ... --clone=false` remedy;
the tool never creates or publishes real GitHub forks implicitly.

Pins still resolve upstream when a new fork lacks those objects. To share a
fork-specific source identity, explicitly use `wb repo pin --source-url <url>`
with the chosen immutable SHA/ref. Managed pushes to a different source URL
are refused until that explicit selection; changing only origin cannot silently
turn upstream pins into non-reproducible fork pins. Local alternate mirrors and
test transports belong in ignored `workspace.remotes` configuration.

## MCP and durable jobs

`devenv shell -- wb mcp` starts the Node stdio server. It supports initialize,
tools/list, typed tools/call and versioned JSON/structured results. Only JSON-RPC
goes to stdout; diagnostics go to stderr. Launch configurations are described in
[config/README.md](../config/README.md).

Sync, source verification and publication default to detached durable jobs over
MCP; pass `background: false` for a bounded foreground operation. CLI commands
use `--background` explicitly. Jobs retain arguments, PID, logs and final
operation receipts under `.state/jobs/`. Disconnect leaves the worker running.
`wb job cancel` terminates its process group and retains transaction evidence.
`wb job resume` can retry interrupted/failed syncs, but publication requires
receipt reconciliation before any new push. Terminal failed/cancelled job status
returns the recorded nonzero exit code as well as its JSON state.

Run `devenv test` for local bare-repository and MCP acceptance. The suite checks
our command behavior; interactive shell activation remains owned by devenv.
No organization changes are pushed by the test suite.

## Component builds

Stage 2 adds `wb build list`, target plans/runs and artifact verification.
See [build usage](builds.md) for clean release snapshots, captured development
diffs, native/guest roots and retained Nix closures. MCP adds `build_list`,
`build_run` and `build_verify` (19 tools total). Build runs default to durable
background jobs over MCP; CLI uses `--background`. Plans evaluate shared Nix
contracts and do not execute compilers or initialize unselected sources.
Windows MSVC/WDK targets fail with code 3 until Stage 4 supplies the backend.
