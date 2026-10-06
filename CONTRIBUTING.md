# Contributing

Begin with the active [stage](docs/stages/README.md) and the
[workspace contracts](docs/architecture.md). This repository owns environment
tooling, cross-repository orchestration and release assembly.

[Agent workflows](docs/agents.md) cover client setup, scoped fork/checkpoint/
publication, component builds and install/loaded-state verification. Devbox setup
creates keys, pins the guest host key and derives SSH configuration automatically.

Nix, devenv and native auto-activation are preconfigured prerequisites. Enter
the trusted checkout and run commands directly in its locked environment.
Use `devenv shell -- <command>` when the execution environment is absent, such
as in CI. Codex can refresh Bash commands using the Nix-generated project
[configuration](config/README.md); no direnv or host hook setup is needed.
Agents use WinBoat MCP for routine workspace operations. CLI requests,
CLI/shell integration checks and operations without an MCP equivalent use
`wb` directly. Virtualization and a container runtime are separate prerequisites
discovered by `wb doctor`. Shell entry must not install host packages or change
system configuration.

Use `wb-format` to format Node sources and manifests and `wb-format-check` to
check them. Both use Prettier from the locked Nix input; explicit file arguments
limit the scope. Development tools belong in Nix. Invoke `git` on PATH to retain
the workspace wrapper, and leave devenv's internal state to its CLI.

Commit at meaningful checkpoints: a validated command family, build target,
provisioning phase or documentation contract. Prefer `feat(scope): ...`,
`fix(scope): ...`, `docs(scope): ...` and `chore(scope): ...`; explain behavior and
validation in the body when needed. Separate component and environment changes.
Preserve unrelated history and contributor work.

Fork mode uses the contributor's namespace as `origin` and keeps
winboat-org as `upstream`. Exact pins remain intact; selection supports single
repositories and subsets. Checkpoint/publish nested changes before parent
gitlinks and root pins using the Stage 1 commands described in
[workspace usage](docs/workspace.md). Managed `git push` in the shell verifies
the actual remote commit before checkpointing pins. Absolute Git paths bypass
the wrapper; use `wb repo push` for clients that do not honor the shell PATH.

Document what each check establishes. A build, artifact upload, installation,
loaded-version check and runtime graphics trial establish different things.
Unavailable downloads, hardware or ISOs are limitations, not successful tests.
