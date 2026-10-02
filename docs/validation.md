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
snapshot, not component/build/graphics compatibility. Stage 1 compiled no component,
provisioned no Windows guest, and attempted no organization push or GitHub fork
creation. Those remain outside Stage 1. The next work is the
[Stage 3 handoff](handoffs/stage-03.md), following the Stage 2 checks below.

## Stage 2 native/cross builds

The unchanged lock supplies six standalone component shells and shared root
operations. [Stage 2 evidence](evidence/stage-02-validation.json) records exact
local commits, manifests, source modes and retained checks. [Build usage](builds.md)
describes exports and guest dispatch.

| Check | Result | What it establishes |
| --- | --- | --- |
| Six standalone shells/interfaces | Passed | Own genuine lock, explicit hashed sources/dependencies, no assumed parent path |
| Native QEMU/renderer/protocol | Passed | Isolated fork output, 19 modules, 80 paired headers and immutable closure |
| QEMU unit suite | 105 passed, 3 expected skips | Native executables run; seccomp confinement, sandbox loopback and alternate AIO backend account for skips |
| Renderer CPU regressions | 5 passed | Queue synchronization, fault tracing/dispatch, string buffer and format-fuzzer checks |
| Venus protocol round-trip | Passed | Generator and paired wire headers from the exact protocol pin |
| Host smoke | Passed | Display enumeration, paired renderer loader identity, SDL/OpenGL module mappings and QMP using SDL dummy display |
| Mesa host | 46 tests passed | Forked Venus/Zink/softpipe output with paired protocol headers and symbols |
| Helios protocol | 14 tests passed | Rust wire library/source artifact with undeclared-license notice |
| WBFreeRDP | Build passed | Forked native binaries/libraries, source license and debug output |
| DXVK cross-build | 4 x64 DLLs passed | PE64, embedded DWARF, exact imports and static GCC/C++/pthread runtime dependencies |
| Guest/application plans | 11 evaluated | MSVC `/MT` engine contracts, x64/x86, local mirrors/tasks; unavailable execution fails with code 3 |
| Artifact verification | Passed | Complete file/link sets and hashes; tamper, extra files and escaping debug links refused |
| `devenv test` and MCP | 25 tests passed, 19 tools | Publication tests plus snapshots/checkout filters, selective plans, artifacts and typed build proxy behavior |
| Local checkpoints/pins | Passed | Explicit paths, matching gitlinks and local object verification; no GitHub publication |

Final evidence separates release builds at clean declared pins from earlier
development snapshots. Development failures/logs remain in ignored state,
including corrected sandbox exports, license paths, wraps, cross dependencies
and the initially skipped QEMU suite. Mesa's release export also exposed and
corrected handling of its declared CRLF checkout filter. Parsing alone was
never build validation.

Hardware Vulkan/render-server tests, interactive SDL, installed Windows outputs
and driver/DLL loaded-state acceptance remain pending. The CPU smoke starts no
installed guest. MSVC/WDK execution awaits Stage 4; WinBoat, Electron and CLVK
adapters refuse missing fixed dependency closures. Helios does not declare a
root/protocol license; its artifact retains attribution and a clarification
notice rather than inventing one.

All QEMU gitlinks and LookingGlass remain uninitialized. The only additional
shader fetch was DXVK's declared nested SPIR-V header gitlink. Six new recipe
commits and matching parent/pins are local-only; exact checks use ignored local
remote overrides. Canonical reachability remains pending publication. Component
CI, release bundles and guest installs were not attempted.
