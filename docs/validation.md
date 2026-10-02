# Scaffold validation

Stage 0 evidence, 2026-10-02. Update this document as the bootstrap blockers are
resolved; later stage acceptance belongs in the corresponding stage document.

| Check | Result | What it establishes |
| --- | --- | --- |
| `devenv init --include-envrc` | Passed, CLI 2.4.0 | Official scaffold initialization |
| Nix parser, all six Nix files | Passed | Expression syntax |
| Pure `nix/checks.nix` evaluation | Passed: 12 entries, 10 exact revisions, 2 unresolved | Structural pin/inventory validation |
| Nix-declared scaffold scripts extracted and run with host Bash/jq | Passed | Actual selector closures 8/3/12/12, argument failures, readiness refusal, scaffold checks and plan output |
| JSON/TOML and `.envrc` syntax | Passed | Shared configuration/sample syntax |
| Local Markdown links | Passed | Documentation targets exist |
| Ignore policy | Passed | Personal docs/state/checkouts/media/keys ignored; lock/shared config/generic user README trackable |
| `devenv update` | Blocked by GitHub DNS access | No Nix lock generated |
| Locked devenv shell / `devenv test` | Pending input fetch | No package/runtime validation claimed |
| Remote source reachability | Unverified; DNS/SSH-config restrictions | Seeds are local object evidence only |
| Root Git staging | Blocked: read-only `.git/index.lock` | Commit exported from a separate writable checkout |

The extracted-script smoke uses the module's actual script strings and manifest
with host tools; it does **not** evaluate nixpkgs, build the devenv shell, launch
MCP or verify Windows/CI behavior. `wb-check --ready` correctly refuses the
unresolved seeds. Stage 1 resolves pins/refs, generates a genuine Nix lock,
builds/tests the shell and validates the actual control-plane MCP.
