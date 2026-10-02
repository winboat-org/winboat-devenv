# Nix ownership

`repositories.nix` owns canonical identities, checkout paths, dependency edges,
subsets and selected submodules. `pins.nix` owns source object IDs and provenance.
`manifest.nix` combines them; `checks.nix` validates without fetching packages.

`dev-shell.nix` declares the locked tools, shell-scoped Git wrapper and validation
commands. `commands/repos.nix` packages the shared Python `wb` operations and
absolute Git/Node/devenv executables. The Node stdio proxy invokes that same
application. `wb-pins` reads current pin data through `wb repo list`; the static
manifest supplies canonical inventory and dependency edges. Stage 2 adds component
adapters and outputs; Stage 3 adds the devbox module. Avoid placeholder build
derivations that report success without an artifact.

The six Helios repositories own their `devenv.nix` and `nix/` recipes after
Stage 2. Recipes for WinBoat, WBFreeRDP, Electron and CLVK stay here. Shared
interfaces live here; component compiler flags belong in their repositories.
`devenv.lock` locks Nix inputs; it does not replace component pins.
The CLI and modules are locked to the same upstream devenv revision. No upstream
patches or replacement shell activation implementation are maintained here.

Bootstrap-only pure checks, usable before packages can be downloaded:

```sh
nix-instantiate --eval --strict --json nix/checks.nix
nix-instantiate --eval --strict --json nix/manifest.nix
```
