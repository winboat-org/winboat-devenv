# Contributing

Begin with the active [stage](docs/stages/README.md) and the
[workspace contracts](docs/architecture.md). This repository owns environment
tooling, cross-repository orchestration and release assembly.

Use `devenv shell` or `devenv shell -- <command>` for routine work. Bootstrap
requires Git, Nix and devenv; virtualization and a container runtime are separate
prerequisites discovered by the later doctor command. Shell entry must not
install host packages or change system configuration.

Commit at meaningful checkpoints: a validated command family, build target,
provisioning phase or documentation contract. Prefer `feat(scope): ...`,
`fix(scope): ...`, `docs(scope): ...` and `chore(scope): ...`; explain behavior and
validation in the body when needed. Separate component and environment changes.
Preserve unrelated history and contributor work.

After Stage 1, fork mode uses the contributor's namespace as `origin` and keeps
winboat-org as `upstream`. Exact pins remain intact; selection supports single
repositories and subsets. Checkpoint/publish nested changes before parent
gitlinks and root pins. Until that tool exists, use explicit Git commands and
record SHAs; this scaffold does not intercept pushes.

Document what each check establishes. A build, artifact upload, installation,
loaded-version check and runtime graphics trial establish different things.
Unavailable downloads, hardware or ISOs are limitations, not successful tests.
