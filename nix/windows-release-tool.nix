{ nixpkgsPath, specification }:
let
  spec = builtins.fromJSON (builtins.readFile specification);
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
  src = builtins.path {
    path = builtins.toPath spec.sourcePath;
    sha256 = spec.narHash;
    name = "windows-release-tool-source";
  };
  sysroot = import ./msvc-sysroot.nix {
    inherit pkgs;
    lockFile = builtins.toPath spec.msvc.lockFile;
    payloads = if spec.msvc.payloads == null then null else builtins.storePath spec.msvc.payloads;
  };
  tools = import ./msvc-cross-tools.nix {
    inherit pkgs sysroot;
    architecture = "x64";
  };
in
{
  inherit
    spec
    pkgs
    src
    tools
    ;
  build =
    { commands, notice }:
    assert builtins.hashFile "sha256" (builtins.toPath spec.msvc.lockFile) == spec.msvc.lockSha256;
    pkgs.runCommand "${spec.target}-${spec.configuration}" { nativeBuildInputs = [ pkgs.python3 ]; } ''
      mkdir -p $out/licenses $out/symbols
      ${commands}
      ${pkgs.python3}/bin/python ${./scripts/msvc-cross-inspect.py} "$out" ${pkgs.llvmPackages_22.llvm}/bin/llvm-readobj --architecture=x64 > $out/images.json
      printf '%s\n' ${pkgs.lib.escapeShellArg notice} > $out/licenses/NOTICE
    '';
}
