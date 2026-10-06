{
  pkgs ? import ./locked-packages.nix,
}:
let
  control = import ./commands/repos.nix {
    inherit pkgs;
    inputs = null;
  };
in
{
  release = import ./release-tools.nix { inherit pkgs; };
  component = control.component;
  windowsComponent = control.windowsComponent;
  sources = control.sourceSync;
  workflows = pkgs.writeShellApplication {
    name = "wb-workflow-check";
    runtimeInputs = [
      pkgs.actionlint
      pkgs.shellcheck
    ];
    text = ''
      exec ${pkgs.actionlint}/bin/actionlint -config-file "$PWD/.github/actionlint.yaml" -shellcheck ${pkgs.shellcheck}/bin/shellcheck "$@"
    '';
  };
}
