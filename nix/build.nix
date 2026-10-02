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
    helios-protocol = recipe "helios" { target = "protocol"; };
    mesa-host = recipe "mesa-helios" {
      target = "host";
      dependencies.protocol = protocol;
    };
    WBFreeRDP = import ./adapters/freerdp.nix {
      inherit pkgs sources;
      configuration = spec.configuration;
    };
  };
in
assert spec.schemaVersion == 1;
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
