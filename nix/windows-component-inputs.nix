{ nixpkgsPath, sourcePath }:
let
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
in
import (builtins.toPath sourcePath + "/nix/windows-inputs.nix") { inherit pkgs; }
