{
  pkgs,
  config,
  inputs,
  ...
}:
let
  lib = pkgs.lib;
  devenv = inputs.devenv-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
  commands = import ./commands/repos.nix { inherit pkgs inputs; };
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
    exec {_wb_codex_fd}< ${lib.escapeShellArg "${config.devenv.root}/.devenv/codex/current"} || {
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
  configuration = (pkgs.formats.toml { }).generate "winboat-codex.toml" {
    features.shell_snapshot = false;
    shell_environment_policy = {
      "inherit" = "all";
      set.BASH_ENV = toString environment;
    };
    hooks.PreToolUse = [
      {
        matcher = "^Bash$";
        hooks = [
          {
            type = "command";
            command = "${pkgs.nodejs}/bin/node ${refresh} ${lib.escapeShellArg config.devenv.root} ${devenv}/bin/devenv";
            timeout = 120;
            statusMessage = "Refresh locked devenv environment";
          }
        ];
      }
    ];
    mcp_servers = {
      devenv = {
        command = "${devenv}/bin/devenv";
        args = [ "mcp" ];
      };
      winboat = {
        command = "${commands.wb}/bin/wb";
        args = [
          "--workspace"
          config.devenv.root
          "mcp"
        ];
        startup_timeout_sec = 120;
        tool_timeout_sec = 60;
      };
    };
  };
in
{
  scripts.wb-codex-config = {
    description = "Print this checkout's locked Codex command environment and MCP configuration";
    exec = "exec ${pkgs.coreutils}/bin/cat ${configuration}";
  };
}
