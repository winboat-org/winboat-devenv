{
  pkgs ? import ./locked-packages.nix,
}:
let
  control = import ./commands/repos.nix {
    inherit pkgs;
    inputs = null;
  };
in
pkgs.writeShellApplication {
  name = "wb-release";
  runtimeInputs = [
    pkgs.nodejs
    pkgs.git
    pkgs.gh
    pkgs.xz
  ];
  text = ''
    case "''${1:-} ''${2:-}" in
      'bundle lock'|'bundle fetch'|'bundle verify'|'bundle prepare'|'bundle complete') ;;
      *) echo 'wb-release supports foreground release input and candidate operations only' >&2; exit 2 ;;
    esac
    ${control.releaseEnvironment}
    exec ${pkgs.nodejs}/bin/node ${control.operationSources}/wb/cli.mjs "$@" --foreground
  '';
}
