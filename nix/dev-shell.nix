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
  testSources = pkgs.runCommand "winboat-test-sources" { } ''
    mkdir -p "$out/tools" "$out/tests" "$out/nix/scripts"
    ln -s ${commands.operationSources}/wb "$out/tools/wb"
    ln -s ${commands.operationSources}/node_modules "$out/tools/node_modules"
    cp ${../tests/helpers.mjs} "$out/tests/helpers.mjs"
    cp ${../tests/integration.mjs} "$out/tests/integration.mjs"
    cp ${../tests/devbox.mjs} "$out/tests/devbox.mjs"
    cp ${../tests/windows.mjs} "$out/tests/windows.mjs"
    cp ${../tests/live-common.mjs} "$out/tests/live-common.mjs"
    cp ${../tests/windows-live.mjs} "$out/tests/windows-live.mjs"
    cp ${../tests/msvc-cross-live.mjs} "$out/tests/msvc-cross-live.mjs"
    cp ${../tests/cross-artifact-live.mjs} "$out/tests/cross-artifact-live.mjs"
    cp ${../tests/refresh.mjs} "$out/tests/refresh.mjs"
    cp ${./scripts/codex-refresh.mjs} "$out/nix/scripts/codex-refresh.mjs"
  '';
in
{
  packages =
    (with pkgs; [
      git
      openssh
      jq
      ripgrep
      nodejs
      nix
      nixfmt
      shellcheck
      bashInteractive
    ])
    ++ [ devenvCli ];
  # scripts outrank the Git package on PATH; the wrapper uses an absolute Git.
  scripts.wb.exec = ''exec ${commands.wb}/bin/wb "$@"'';
  scripts.git.exec = ''exec ${commands.git}/bin/git "$@"'';
  scripts.wb-test.exec = ''
    ${commands.environment}
    export WB_REAL_GIT=${pkgs.git}/bin/git
    export WB_MANIFEST_FILE=${manifestFile}
    export WB_TEST_SOURCE="$WB_WORKSPACE_ROOT"
    export WB_TEST_COMMAND=${commands.wb}/bin/wb
    export WB_TEST_GIT=${commands.git}/bin/git
    exec ${pkgs.nodejs}/bin/node --test "$@" ${testSources}/tests/integration.mjs ${testSources}/tests/refresh.mjs
  '';
  scripts.wb-devbox-test.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node --experimental-test-module-mocks --test ${testSources}/tests/devbox.mjs "$@"
  '';
  scripts.wb-windows-test.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node --experimental-test-module-mocks --test ${testSources}/tests/windows.mjs "$@"
  '';
  scripts.wb-windows-live.exec = ''
    ${commands.environment}
    export WB_LIVE_COMMAND=${commands.wb}/bin/wb
    exec ${pkgs.nodejs}/bin/node ${testSources}/tests/windows-live.mjs "$@"
  '';
  scripts.wb-msvc-cross-live.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node ${testSources}/tests/msvc-cross-live.mjs "$@"
  '';
  scripts.wb-cross-artifact-live.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node ${testSources}/tests/cross-artifact-live.mjs "$@"
  '';
  scripts.wb-windows-check.exec = ''
    exec ${pkgs.powershell}/bin/pwsh -NoProfile -File ${./scripts/windows-syntax.ps1} "$WB_WORKSPACE_ROOT/nix/windows" "$WB_WORKSPACE_ROOT/config/provision.lock.json"
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
    wb-devbox-test
    wb-windows-test
    wb-windows-check
  '';
}
