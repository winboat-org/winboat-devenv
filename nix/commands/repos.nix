{ pkgs, inputs }:
let
  manifest = pkgs.writeText "winboat-repositories.json" (builtins.toJSON (import ../manifest.nix));
  buildTargets = pkgs.writeText "winboat-build-targets.json" (
    builtins.toJSON (import ../build-targets.nix)
  );
  # Read each operation explicitly so devenv tracks adapter edits in its cache.
  buildOperations = pkgs.runCommand "winboat-build-operations" { } (
    "mkdir -p $out/adapters $out/scripts\n"
    +
      pkgs.lib.concatMapStringsSep "\n"
        (
          name:
          ''cp ${
            pkgs.writeText (builtins.baseNameOf name) (builtins.readFile (../. + "/${name}"))
          } "$out/${name}"''
        )
        [
          "build.nix"
          "dispatch.nix"
          "host-smoke.nix"
          "scripts/host-smoke.py"
          "adapters/venus-protocol.nix"
          "adapters/freerdp.nix"
          "adapters/winboat.nix"
          "adapters/electron.nix"
          "adapters/clvk.nix"
        ]
  );
  devenv = inputs.devenv-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
  operationSources = pkgs.runCommand "winboat-operation-sources" { } (
    "mkdir -p $out/wb $out/mcp\n"
    +
      pkgs.lib.concatMapStringsSep "\n"
        (
          name:
          ''cp ${
            pkgs.writeText (builtins.baseNameOf name) (builtins.readFile (../../tools + "/${name}"))
          } "$out/${name}"''
        )
        [
          "wb/__init__.py"
          "wb/__main__.py"
          "wb/activation.py"
          "wb/builds.py"
          "wb/common.py"
          "wb/jobs.py"
          "wb/publication.py"
          "wb/repos.py"
          "wb/workspace.py"
          "mcp/server.mjs"
        ]
  );
  environment = ''
    export WB_REAL_GIT=${pkgs.git}/bin/git
    export WB_MANIFEST_FILE=${manifest}
    export WB_DEVENV=${devenv}/bin/devenv
    export WB_NODE=${pkgs.nodejs}/bin/node
    export WB_MCP_SERVER=${operationSources}/mcp/server.mjs
    export WB_OPERATION_SOURCES=${operationSources}
    export WB_BUILD_TARGETS=${buildTargets}
    export WB_BUILD_EXPRESSION=${buildOperations}/build.nix
    export WB_DISPATCH_EXPRESSION=${buildOperations}/dispatch.nix
    export WB_NIX=${pkgs.nix}/bin/nix
    export WB_NIXPKGS=${pkgs.path}
    export WB_SYSTEM=${pkgs.stdenv.hostPlatform.system}
    export WB_OBJDUMP=${pkgs.binutils}/bin/objdump
    export WB_READELF=${pkgs.binutils}/bin/readelf
    export WB_COMMAND="$0"
    export PYTHONPATH=${operationSources}
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
        pkgs.nix
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
