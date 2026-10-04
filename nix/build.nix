{ nixpkgsPath, specification }:
let
  spec = builtins.fromJSON (builtins.readFile specification);
  pkgs = import (builtins.toPath nixpkgsPath) { system = spec.system; };
  sources = builtins.mapAttrs (
    name: source:
    builtins.path {
      path = builtins.toPath source.path;
      name = "${name}-source";
      sha256 = source.narHash;
    }
  ) spec.sources;
  recipe =
    name: args:
    import (sources.${name} + "/nix/default.nix") (
      {
        inherit pkgs sources;
        configuration = spec.configuration;
      }
      // args
    );
  protocol = import ./adapters/venus-protocol.nix { inherit pkgs sources; };
  renderer = recipe "virglrenderer" {
    target = "host";
    dependencies.protocol = protocol;
  };
  qemu = recipe "qemu-helios" {
    target = "host";
    dependencies.renderer = renderer;
  };
  smoke = import ./host-smoke.nix {
    inherit
      pkgs
      qemu
      renderer
      protocol
      ;
  };
  msvcSysroot = import ./msvc-sysroot.nix {
    inherit pkgs;
    lockFile = builtins.toPath spec.msvc.lockFile;
    payloads = if spec.msvc.payloads == null then null else builtins.storePath spec.msvc.payloads;
  };
  hostWidl = import ./host-widl.nix { inherit pkgs; };
  msvcDependencies = architecture: {
    msvcSysroot = msvcSysroot;
    msvcCrossFile = import ./msvc-meson.nix {
      inherit pkgs architecture hostWidl;
      sysroot = msvcSysroot;
    };
    msvcInspector = ./scripts/msvc-cross-inspect.py;
  };
  packages = {
    venus-protocol = protocol;
    virglrenderer = renderer;
    qemu-helios = qemu;
    host-stack = pkgs.symlinkJoin {
      name = "winboat-host-stack";
      paths = [
        qemu
        qemu.debug
        renderer
        renderer.debug
        protocol
        smoke
      ];
    };
    dxvk-win64 = recipe "dxvk" { target = "win64"; };
    dxvk-engine-x64 = recipe "dxvk" {
      target = "engine-x64";
      dependencies = msvcDependencies "x64";
    };
    dxvk-engine-x86 = recipe "dxvk" {
      target = "engine-x86";
      dependencies = msvcDependencies "x86";
    };
    vkd3d-engine-x64 = recipe "vkd3d-proton" {
      target = "engine-x64";
      dependencies = msvcDependencies "x64" // {
        inherit hostWidl;
      };
    };
    vkd3d-engine-x86 = recipe "vkd3d-proton" {
      target = "engine-x86";
      dependencies = msvcDependencies "x86" // {
        inherit hostWidl;
      };
    };
    helios-protocol = recipe "helios" { target = "protocol"; };
    mesa-host = recipe "mesa-helios" {
      target = "host";
      dependencies.protocol = protocol;
    };
    mesa-guest-x64 = recipe "mesa-helios" {
      target = "guest-x64";
      dependencies = msvcDependencies "x64" // {
        inherit protocol;
      };
    };
    mesa-guest-x86 = recipe "mesa-helios" {
      target = "guest-x86";
      dependencies = msvcDependencies "x86" // {
        inherit protocol;
      };
    };
    WBFreeRDP = import ./adapters/freerdp.nix {
      inherit pkgs sources;
      configuration = spec.configuration;
    };
    clvk-helios = import ./adapters/clvk-cross.nix {
      inherit pkgs sources;
      configuration = spec.configuration;
      sysroot = msvcSysroot;
    };
  };
in
assert spec.schemaVersion == 1;
assert
  !(spec ? msvc)
  || builtins.hashFile "sha256" (builtins.toPath spec.msvc.lockFile) == spec.msvc.lockSha256;
let
  selected = packages.${spec.target};
in
if selected ? debug then
  pkgs.symlinkJoin {
    name = "${spec.target}-with-symbols";
    paths = [
      selected
      selected.debug
    ];
  }
else
  selected
