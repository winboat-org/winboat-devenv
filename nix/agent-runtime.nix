{ pkgs, inputs }:
let
  lib = pkgs.lib;
  devenv = inputs.devenv-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
  # Reuse the locked CLI's environment restoration, including removed variables.
  bashSource = builtins.readFile (inputs.devenv-cli + "/devenv-shell/src/dialect/bash.rs");
  helperSource = builtins.elemAt (lib.splitString "fn env_diff_helpers(&self) -> &str {" bashSource) 1;
  helpers = builtins.head (
    lib.splitString ''"#'' (builtins.elemAt (lib.splitString ''r#"'' helperSource) 1)
  );
  pinnedHelpers =
    lib.replaceStrings
      [
        "gzip -c"
        "gzip -d"
        "base64 -w0"
        "base64 -d"
        "LC_ALL=C sort"
        "$(mktemp)"
        "rm -f"
      ]
      [
        "${pkgs.gzip}/bin/gzip -c"
        "${pkgs.gzip}/bin/gzip -d"
        "${pkgs.coreutils}/bin/base64 -w0"
        "${pkgs.coreutils}/bin/base64 -d"
        "LC_ALL=C ${pkgs.coreutils}/bin/sort"
        "$(${pkgs.coreutils}/bin/mktemp)"
        "${pkgs.coreutils}/bin/rm -f"
      ]
      helpers;
  environment = pkgs.writeShellScript "winboat-codex-bash-env" ''
    # Keep the opened generation stable while another hook publishes a refresh.
    exec {_wb_codex_fd}< "$WB_CODEX_WORKSPACE/.state/codex/current" || {
      echo 'Codex environment has not been refreshed by its PreToolUse hook.' >&2
      exit 1
    }
    IFS= read -r _wb_codex_env <&"$_wb_codex_fd" || exit 1
    if [[ "''${_WB_CODEX_ENV:-}" != "$_wb_codex_env" ]]; then
      ${pinnedHelpers}
      __devenv_apply_reverse_diff
      _wb_codex_before=$(${pkgs.coreutils}/bin/mktemp)
      __devenv_capture_env > "$_wb_codex_before"
      source "/dev/fd/$_wb_codex_fd" || exit $?
      __devenv_compute_diff "$_wb_codex_before"
      ${pkgs.coreutils}/bin/rm -f "$_wb_codex_before"
      export _WB_CODEX_ENV="$_wb_codex_env"
    fi
    exec {_wb_codex_fd}<&-
    unset _wb_codex_env _wb_codex_before _wb_codex_fd
  '';
  refresh = pkgs.writeText "winboat-codex-refresh.mjs" (
    builtins.readFile ./scripts/codex-refresh.mjs
  );
  nixMcp = pkgs.writeShellScript "winboat-nix-mcp" ''
    set -euo pipefail
    cd -- "$1"
    exec ${devenv}/bin/devenv mcp
  '';
in
pkgs.writeText "winboat-agent-runtime.json" (
  builtins.toJSON {
    node = "${pkgs.nodejs}/bin/node";
    devenv = "${devenv}/bin/devenv";
    nixMcp = toString nixMcp;
    bashEnv = toString environment;
    refresh = toString refresh;
  }
)
