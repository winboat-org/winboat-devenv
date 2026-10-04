{ nixpkgsPath, sourcePath }:
let
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
  source = builtins.toPath sourcePath;
in
import (source + "/nix/windows-dependencies.nix") {
  inherit pkgs;
  sources.helios = source;
}
