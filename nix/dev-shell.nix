{ pkgs, config, ... }:
let
  manifest = import ./manifest.nix;
  checks = import ./checks.nix;
  manifestFile = pkgs.writeText "winboat-repositories.json" (builtins.toJSON manifest);
in
{
  packages = with pkgs; [ git openssh jq ripgrep nodejs nixfmt shellcheck ];
  env.WB_WORKSPACE_ROOT = config.devenv.root;

  scripts.wb-pins = {
    description = "List seed pins for a subset and its dependencies";
    exec = ''
      set -euo pipefail
      if [ "$#" -gt 1 ]; then
        echo 'usage: wb-pins [all|helios|winboat|winboat-accel]' >&2
        exit 2
      fi
      subset="''${1:-all}"
      jq --arg subset "$subset" '
        . as $manifest |
        def closure($names):
          ($names + [$names[] as $name | $manifest.repositories[$name].dependencies[]] | unique) as $next |
          if ($next | length) == ($names | unique | length) then $next else closure($next) end;
        (if $subset == "all" then .repositories | keys
         elif .subsets[$subset] != null then closure(.subsets[$subset])
         else error("unknown subset: " + $subset) end) as $selected |
        {subset: $subset, repositories: [.repositories | to_entries[] |
          select(.key as $name | $selected | index($name)) |
          {name: .key, url: .value.url, path: .value.path, pin: .value.pin}]}
      ' ${manifestFile}
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
  '';
}
