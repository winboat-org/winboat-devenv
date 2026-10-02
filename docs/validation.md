# Validation

Stage 1 repository/MCP acceptance passed on 2026-10-02. Retained
[validation evidence](evidence/stage-01-validation.json) records the exact lock,
tool versions, configured MCP launch and live source inventory. The
[source evidence](evidence/stage-01-sources.json) separately records canonical
object/ref verification. All execution used the locked shell after bootstrap.

| Check | Result | What it establishes |
| --- | --- | --- |
| Genuine `devenv update` and shell evaluation | Passed | Fetched input hashes; CLI/modules share upstream revision `fe20b5cba7ab5e93ae73f956a8d3efc50e1753f4` |
| `devenv test` | Passed, 21 integration tests | Real local bare Git publication and Node MCP behavior; no GitHub pushes |
| Selection/sync fixtures | Passed | Single/all/subsets, dependencies, nested parents, exact gitlinks, selective third-party modules and paths containing spaces |
| Dirty/conflict protection | Passed | Working/index hashes preserved, unselected work retained, affected sync refused before source mutation |
| Scoped checkpoints and pin writers | Passed | Explicit paths/deletions, parent gitlinks, concurrent disjoint updates, unrelated root/index and same-file staged edits preserved |
| Git push wrapper | Passed | Delegation/global flags, successful/failed/dry-run/no-op/refspec/tag/delete cases, detached HEAD, lease and conservative ambiguity/pushurl handling |
| Post-push recovery | Passed | Injected pin-write and pin-commit failures retain remote success; reconciliation verifies the SHA without repushing; remote drift refused |
| Fork mode | Passed with local forks | Selected origin/upstream changes, missing-fork refusal, explicit fork source pins and unchanged global configuration |
| MCP fixtures | Passed | Initialize/list, typed failure, CLI parity, sync/fork/checkpoint, background disconnect and publication cancellation/retry refusal |
| Configured `devenv shell -- wb mcp` launch | Passed | 16 tools, JSON-RPC stdout, status identical to CLI; Claude config and Codex template use this launch |
| Live canonical source sync | Passed, 12 clean checkouts at exact pins | Includes DXIL-SPIRV/Venus and the resolved WBFreeRDP/Electron pins |
| Live submodule scope | Passed | All 16 declared QEMU submodules and LookingGlass remain uninitialized |
| Explicit shell entry | Passed | Managed/root HEAD, status and index hashes unchanged |
| Syntax/format checks | Passed | Node syntax, Bash shellcheck, Nix formatting and whitespace checks |

The locked shell uses devenv `2.4.1+fe20b5c`, Git `2.55.0`, Node `24.20.0`,
Python `3.14.7` and Nix `2.34.8`. The CLI and modules are unmodified upstream
sources. The earlier scaffold network and writable-Git blockers are resolved;
the imported scaffold history and unrelated external reference work are retained.

Native interactive activation is owned by devenv. At the maintainer's request,
the PTY activation harness and activation-specific regression tests were removed;
they are not part of `devenv test`. Setup/doctor still supply native hooks and
delegate trust to devenv. An exploratory native Fish check exposed an unquoted
initialization path when the workspace contains spaces. No upstream patch is
retained. See [activation](auto-activation.md) for explicit execution/direnv use.
Interactive entry/exit behavior across all shells is not claimed as validated.

Source reachability and clean synchronization establish a reproducible source
snapshot, not component/build/graphics compatibility. No component was compiled,
no Windows guest was provisioned, and no real organization push or GitHub fork
creation was attempted. Those remain outside Stage 1. The next work is the
[Stage 2 handoff](handoffs/stage-02.md).
