{ pkgs, inputs, ... }:
let
  commands = import ./commands/repos.nix { inherit pkgs inputs; };
in
{
  scripts.wb-codex-config = {
    description = "Print this checkout's locked Codex command environment and MCP configuration";
    exec = ''
      ${commands.wb}/bin/wb --workspace "$WB_WORKSPACE_ROOT" --json agents config --client codex | ${pkgs.jq}/bin/jq -er .result.content
    '';
  };
}
