{ pkgs, inputs }:
let
  manifest = pkgs.writeText "winboat-repositories.json" (builtins.toJSON (import ../manifest.nix));
  devenv = inputs.devenv-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
  environment = ''
    export WB_REAL_GIT=${pkgs.git}/bin/git
    export WB_MANIFEST_FILE=${manifest}
    export WB_DEVENV=${devenv}/bin/devenv
    export WB_NODE=${pkgs.nodejs}/bin/node
    export WB_MCP_SERVER=${../../tools/mcp/server.mjs}
    export WB_COMMAND="$0"
    export PYTHONPATH=${../../tools}
  '';
  command =
    name: arguments:
    pkgs.writeShellApplication {
      inherit name;
      runtimeInputs = [
        pkgs.python3
        pkgs.nodejs
        pkgs.git
        pkgs.openssh
        devenv
      ];
      text = environment + ''
        exec ${pkgs.python3}/bin/python3 -m wb ${arguments} "$@"
      '';
    };
in
{
  wb = command "wb" "";
  git = command "git" "git-wrapper";
}
