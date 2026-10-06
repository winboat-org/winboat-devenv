# Nix ownership

`agent-runtime.nix` packages the shared Codex Bash handoff, refresh script and
devenv MCP launcher. `wb setup --agents` and `wb-codex-config` render/merge those
same runtime identities. `wb-agents-live` is the Nix-declared client/protocol
acceptance entry point; it does not install clients or modify approval policies.

`repositories.nix` owns canonical identities, checkout paths, dependency edges,
subsets and selected submodules. `pins.nix` owns source object IDs and provenance.
`manifest.nix` combines them; `checks.nix` validates without fetching packages.

`ci.nix` defines the individual CI command packages. `locked-packages.nix`
resolves the root nixpkgs input from the existing `devenv.lock`, including its
content hash. `ci-environment.nix` supplies those commands and base tools to
the development environment; `dev-shell.nix` adds editing, agent and devbox tools,
the shell-scoped Git wrapper and validation commands. `control-sources.nix`
packages the shared Node sources and dependencies once for CI and development.
`commands/repos.nix` packages the shared Node.js `wb` operations and
absolute Git/Node/devenv executables. `devbox.nix` imports the exact Stage 2
closure into a container; `scripts/devbox-run.mjs` owns its runtime entry point
and `windows/` owns provisioning/mirror/signing payloads. The typed Node stdio proxy
invokes that same application. Windows autologin, offline install/probe operations, state recovery
and local fixture builds are shared payloads rather than MCP implementations.
`tools/package-lock.json` supplies exact Node dependency versions and integrity
hashes through `importNpmLock`; no Python interpreter implements `wb`. Python
compiler helpers remain inside their Nix build recipes.

`dev-shell.nix` supplies Prettier from the locked nixpkgs input. `wb-format` and
`wb-format-check` format or check the Node sources and manifests, with optional
file arguments. Formatting checks also run in `devenv test`. The Codex refresh
handoff belongs under `.state/codex/`; project code uses the devenv CLI without
reading or modifying its internal state directory.

`wb-pins` reads current pin data through `wb repo list`; the static
manifest supplies canonical inventory and dependency edges. Stage 2 adds component
adapters and outputs; Stage 3 adds the devbox module. Avoid placeholder build
derivations that report success without an artifact.

The six Helios repositories own their `devenv.nix` and `nix/` recipes after
Stage 2. Recipes for WinBoat, WBFreeRDP, Electron and CLVK stay here. Shared
interfaces live here; component compiler flags belong in their repositories.
`devenv.lock` locks Nix inputs; it does not replace component pins.
The CLI and modules are locked to the same upstream devenv revision. No upstream
patches or replacement shell activation implementation are maintained here.

`build-adl-compatibility.nix` cross-compiles `atiadlxx.dll` and retains the Resolve
helper scripts. `build-catalog-verifier.nix` cross-compiles `VerifyCatalog.exe`.
Both use `windows-release-tool.nix` for the locked MSVC SDK, x64 toolchain,
static-CRT image inspection, PDB directories and source attribution. Component
workflows run these recipes; the root release command consumes their prebuilt
artifacts.

Bootstrap-only pure checks, usable before packages can be downloaded:

```sh
nix-instantiate --eval --strict --json nix/checks.nix
nix-instantiate --eval --strict --json nix/manifest.nix
```
