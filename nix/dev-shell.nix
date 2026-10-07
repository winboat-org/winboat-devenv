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
  format = mode: ''
    cd -- "$WB_WORKSPACE_ROOT"
    if [ "$#" -eq 0 ]; then
      set -- 'tools/**/*.mjs' 'tools/**/*.json' 'tests/**/*.mjs' 'nix/scripts/*.mjs'
    fi
    exec ${pkgs.prettier}/bin/prettier ${mode} "$@"
  '';
  testSources = pkgs.runCommand "winboat-test-sources" { } ''
    mkdir -p "$out/tools" "$out/tests" "$out/nix/scripts"
    ln -s ${commands.operationSources}/wb "$out/tools/wb"
    ln -s ${commands.operationSources}/node_modules "$out/tools/node_modules"
    ln -s ${commands.operationSources}/node_modules "$out/node_modules"
    cp ${../tests/helpers.mjs} "$out/tests/helpers.mjs"
    cp ${../tests/integration.mjs} "$out/tests/integration.mjs"
    cp ${../tests/devbox.mjs} "$out/tests/devbox.mjs"
    cp ${../tests/windows.mjs} "$out/tests/windows.mjs"
    cp ${../tests/live-common.mjs} "$out/tests/live-common.mjs"
    cp ${../tests/windows-live.mjs} "$out/tests/windows-live.mjs"
    cp ${../tests/msvc-cross-live.mjs} "$out/tests/msvc-cross-live.mjs"
    cp ${../tests/cross-artifact-live.mjs} "$out/tests/cross-artifact-live.mjs"
    cp ${../tests/agents-live.mjs} "$out/tests/agents-live.mjs"
    cp ${../tests/agents.mjs} "$out/tests/agents.mjs"
    cp ${../tests/refresh.mjs} "$out/tests/refresh.mjs"
    cp ${../tests/bundles.mjs} "$out/tests/bundles.mjs"
    cp ${../tests/release-recipes.mjs} "$out/tests/release-recipes.mjs"
    cp ${../tests/sdk-download.py} "$out/tests/sdk-download.py"
    cp ${./scripts/msvc-sdk-download.py} "$out/nix/scripts/msvc-sdk-download.py"
    cp ${./scripts/codex-refresh.mjs} "$out/nix/scripts/codex-refresh.mjs"
  '';
in
{
  packages =
    (with pkgs; [
      openssh
      jq
      ripgrep
      prettier
      nixfmt
      bashInteractive
    ])
    ++ [ devenvCli ];
  # scripts outrank the Git package on PATH; the wrapper uses an absolute Git.
  scripts.wb.exec = ''exec ${commands.wb}/bin/wb "$@"'';
  scripts.git.exec = ''exec ${commands.git}/bin/git "$@"'';
  scripts.wb-format = {
    description = "Format Node sources and manifests with Nix-pinned Prettier";
    exec = format "--write";
  };
  scripts.wb-format-check = {
    description = "Check Node formatting with Nix-pinned Prettier";
    exec = format "--check";
  };
  scripts.wb-test.exec = ''
    ${commands.environment}
    export WB_REAL_GIT=${pkgs.git}/bin/git
    export WB_MANIFEST_FILE=${manifestFile}
    export WB_TEST_SOURCE="$WB_WORKSPACE_ROOT"
    export WB_TEST_COMMAND=${commands.wb}/bin/wb
    export WB_TEST_GIT=${commands.git}/bin/git
    exec ${pkgs.nodejs}/bin/node --test "$@" ${testSources}/tests/integration.mjs ${testSources}/tests/refresh.mjs ${testSources}/tests/agents.mjs
  '';
  scripts.wb-devbox-test.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node --experimental-test-module-mocks --test ${testSources}/tests/devbox.mjs "$@"
  '';
  scripts.wb-bundle-test.exec = ''
    ${commands.environment}
    export WB_TEST_SOURCE="$WB_WORKSPACE_ROOT"
    export WB_TEST_COMMAND=${commands.wb}/bin/wb
    exec ${pkgs.nodejs}/bin/node --experimental-test-module-mocks --test ${testSources}/tests/bundles.mjs "$@"
  '';
  scripts.wb-sdk-download-test.exec = ''
    exec ${pkgs.python3}/bin/python ${testSources}/tests/sdk-download.py
  '';
  scripts.wb-ci-component.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node ${commands.operationSources}/wb/release-producer.mjs "$@"
  '';
  scripts.wb-release-recipes-check.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node ${testSources}/tests/release-recipes.mjs "$@"
  '';
  scripts.wb-windows-test.exec = ''
    ${commands.environment}
    exec ${pkgs.nodejs}/bin/node --experimental-test-module-mocks --test ${testSources}/tests/windows.mjs "$@"
  '';
  scripts.wb-agents-live.exec = ''
    ${commands.environment}
    export WB_LIVE_COMMAND=${commands.wb}/bin/wb
    exec ${pkgs.nodejs}/bin/node ${testSources}/tests/agents-live.mjs "$@"
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
    ${pkgs.powershell}/bin/pwsh -NoProfile -File ${./scripts/windows-syntax.ps1} "$WB_WORKSPACE_ROOT/nix/windows" "$WB_WORKSPACE_ROOT/config/provision.lock.json"
    ${pkgs.powershell}/bin/pwsh -NoProfile -File ${./scripts/windows-syntax.ps1} "$WB_WORKSPACE_ROOT/packaging/windows" "$WB_WORKSPACE_ROOT/config/provision.lock.json"
    ${pkgs.powershell}/bin/pwsh -NoProfile -File ${./scripts/windows-syntax.ps1} "$WB_WORKSPACE_ROOT/ci/windows" "$WB_WORKSPACE_ROOT/config/provision.lock.json"
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
  # The locked CLI runs the test task graph. Attach validation explicitly so
  # a successful empty enterTest task cannot stand in for the actual checks.
  tasks."winboat:validation" = {
    before = [ "devenv:enterTest" ];
    after = [ "devenv:enterShell" ];
    wantedBy = [ "devenv:enterTest" ];
    exec = ''
      set -euo pipefail
      ${pkgs.coreutils}/bin/mkdir -p "$WB_WORKSPACE_ROOT/.state/validation"
      validation_log=$(${pkgs.coreutils}/bin/mktemp "$WB_WORKSPACE_ROOT/.state/validation/native.XXXXXXXX.log")
      exec >"$validation_log" 2>&1
      wb-format-check
      wb-workflow-check
      wb-check
      wb-test
      wb-devbox-test
      wb-windows-test
      wb-bundle-test
      wb-sdk-download-test
      wb-windows-check
      ${pkgs.coreutils}/bin/printf '%s\n' "$validation_log" > "$WB_WORKSPACE_ROOT/.state/validation/last-path"
    '';
  };
}
