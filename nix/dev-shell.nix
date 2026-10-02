{
  pkgs,
  config,
  inputs,
  ...
}:
let
  manifest = import ./manifest.nix;
  checks = import ./checks.nix;
  manifestFile = pkgs.writeText "winboat-repositories.json" (builtins.toJSON manifest);
  commands = import ./commands/repos.nix { inherit pkgs inputs; };
  devenvCli = inputs.devenv-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  packages =
    (with pkgs; [
      git
      openssh
      jq
      ripgrep
      nodejs
      python3
      nix
      nixfmt
      shellcheck
      bashInteractive
      zsh
      fish
      nushell
      direnv
    ])
    ++ [ devenvCli ];
  # scripts outrank the Git package on PATH; the wrapper uses an absolute Git.
  scripts.wb.exec = ''exec ${commands.wb}/bin/wb "$@"'';
  scripts.git.exec = ''exec ${commands.git}/bin/git "$@"'';
  scripts.wb-test.exec = ''
    export WB_REAL_GIT=${pkgs.git}/bin/git
    export WB_MANIFEST_FILE=${manifestFile}
    export WB_TEST_SOURCE="$WB_WORKSPACE_ROOT"
    export WB_TEST_COMMAND=${commands.wb}/bin/wb
    export WB_TEST_GIT=${commands.git}/bin/git
    export PYTHONPATH=${../tools}
    exec ${pkgs.python3}/bin/python3 ${../tests/integration.py} "$@"
  '';
  env.WB_WORKSPACE_ROOT = config.devenv.root;
  env.WB_NIXPKGS = toString pkgs.path;

  scripts.wb-pins = {
    description = "List current pins for a subset and its dependencies";
    exec = ''
      set -euo pipefail
      if [ "$#" -gt 1 ]; then
        echo 'usage: wb-pins [all|helios|winboat|winboat-accel]' >&2
        exit 2
      fi
      subset="''${1:-all}"
      ${commands.wb}/bin/wb --json repo list --subset "$subset" | jq --arg subset "$subset" '
        {subset: $subset, repositories: [.result.repositories[] |
          {name: .repository, url, path, pin}]}
      '
    '';
  };
  scripts.wb-check = {
    description = "Validate scaffold; --ready also requires all pins and the Nix lock";
    exec = ''
      set -euo pipefail
      if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != '--ready' ]; }; then
        echo 'usage: wb-check [--ready]' >&2
        exit 2
      fi
      echo '${builtins.toJSON checks}' | jq .
      if [ "''${1:-}" = '--ready' ]; then
        if ! echo '${builtins.toJSON checks}' | jq -e '.readyForAllRepositories' >/dev/null; then
          echo 'Not ready: resolve the listed source pins; see docs/repositories.md.' >&2
          exit 1
        fi
        if [ ! -s "$WB_WORKSPACE_ROOT/devenv.lock" ]; then
          echo 'Not ready: generate and commit devenv.lock with devenv update.' >&2
          exit 1
        fi
      fi
    '';
  };
  scripts.wb-plan = {
    description = "Show implementation stages";
    exec = ''
      cat "$WB_WORKSPACE_ROOT/docs/stages/README.md"
    '';
  };

  # Shell entry only supplies tools; later mutations need an explicit command.
  enterTest = ''
    wb-check
    wb-pins helios | jq -e '.repositories | length == 8' >/dev/null
    wb-pins winboat | jq -e '.repositories | length == 3' >/dev/null
    wb-pins winboat-accel | jq -e '.repositories | length == 12' >/dev/null
    wb-test
  '';
}
