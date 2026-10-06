{ pkgs, ... }:
let
  ci = import ./ci.nix { inherit pkgs; };
in
{
  packages = [
    pkgs.git
    pkgs.gh
    pkgs.nix
    pkgs.nodejs
    pkgs.actionlint
    pkgs.shellcheck
    pkgs.xz
    ci.release
    ci.workflows
    ci.sources
    ci.component
    ci.windowsComponent
  ];
}
