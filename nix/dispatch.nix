{ nixpkgsPath, request }:
let
  spec = builtins.fromJSON request;
  pkgs = import (builtins.toPath nixpkgsPath) { system = spec.system; };
  sources = builtins.mapAttrs (_: source: builtins.toPath source.path) spec.sources;
  load =
    name: target:
    import (sources.${name} + "/nix/default.nix") {
      inherit pkgs sources target;
      inherit (spec) configuration;
      dependencies.protocol = "@protocolArtifact@";
    };
  plans = {
    dxvk-engine-x64 = load "dxvk" "engine-x64";
    dxvk-engine-x86 = load "dxvk" "engine-x86";
    vkd3d-engine-x64 = load "vkd3d-proton" "engine-x64";
    vkd3d-engine-x86 = load "vkd3d-proton" "engine-x86";
    helios-guest-x64 = load "helios" "guest-x64";
    helios-guest-x86 = load "helios" "guest-x86";
    helios-development-package = load "helios" "development-package";
    mesa-guest-x64 = load "mesa-helios" "guest-x64";
    mesa-guest-x86 = load "mesa-helios" "guest-x86";
    clvk-helios = load "clvk-helios" "guest-x64";
    electron = import ./adapters/electron.nix;
    winboat = import ./adapters/winboat.nix;
  };
in
let
  selected = plans.${spec.target};
in
selected
// {
  backendAvailable = builtins.elem spec.target [
    "dxvk-engine-x64"
    "dxvk-engine-x86"
    "vkd3d-engine-x64"
    "vkd3d-engine-x86"
    "helios-guest-x64"
    "helios-guest-x86"
    "mesa-guest-x64"
    "mesa-guest-x86"
  ];
}
// pkgs.lib.optionalAttrs (selected.backend == "devbox") {
  sourceMirrorRoot = "C:\\WinBoatDev\\src";
  buildRoot = "C:\\WinBoatDev\\build";
  cargoTargetRoot = "C:\\WinBoatDev\\build\\cargo";
  execution = "durable-elevated-task";
  payloadTransport = "Nix-declared-shared-operation";
  bindingContract = {
    schemaVersion = 1;
    tokens = [
      "@sourceDirectory@"
      "@buildDirectory@"
      "@nativeFile@"
      "@specification@"
      "@heliosSourceDirectory@"
      "@protocolArtifact@"
    ];
    rule = "Stage 4 binds applicable tokens to verified local Windows mirrors, build directories and transferred recipe files before execution.";
  };
}
