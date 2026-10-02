# Nix ownership

`repositories.nix` owns canonical identities, checkout paths, dependency edges,
subsets and selected submodules. `pins.nix` owns source object IDs and provenance.
`manifest.nix` combines them; `checks.nix` validates without fetching packages.

`dev-shell.nix` declares tooling and three read-only scaffold commands. Stage 1
adds repository commands as Nix-defined applications. Stage 2 adds component
adapters and outputs; Stage 3 adds the devbox module. Avoid placeholder build
derivations that report success without an artifact.

The six Helios repositories own their `devenv.nix` and `nix/` recipes after
Stage 2. Recipes for WinBoat, WBFreeRDP, Electron and CLVK stay here. Shared
interfaces live here; component compiler flags belong in their repositories.
`devenv.lock` locks Nix inputs; it does not replace component pins.

Bootstrap-only pure checks, usable before packages can be downloaded:

```sh
nix-instantiate --eval --strict --json nix/checks.nix
nix-instantiate --eval --strict --json nix/manifest.nix
```
