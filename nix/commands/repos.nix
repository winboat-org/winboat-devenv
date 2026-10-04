{ pkgs, inputs }:
let
  python = pkgs.python3.withPackages (ps: [ ps.pyyaml ]);
  manifest = pkgs.writeText "winboat-repositories.json" (builtins.toJSON (import ../manifest.nix));
  buildTargets = pkgs.writeText "winboat-build-targets.json" (
    builtins.toJSON (import ../build-targets.nix)
  );
  # Read each operation explicitly so devenv tracks adapter edits in its cache.
  buildOperations = pkgs.runCommand "winboat-build-operations" { } (
    "mkdir -p $out/adapters $out/scripts $out/windows\n"
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
          "devbox.nix"
          "windows-payloads.nix"
          "windows-build-tools.nix"
          "windows-rust-deps.nix"
          "windows-utilities.nix"
          "windows-component-inputs.nix"
          "scripts/devbox-run.py"
          "scripts/windows-win-flex.py"
          "windows/Bootstrap.ps1"
          "windows/Autologin.ps1"
          "windows/Provision.ps1"
          "windows/Toolchain.ps1"
          "windows/Mirror.ps1"
          "windows/BuildFixture.ps1"
          "windows/Shutdown.ps1"
          "windows/TestDriver.c"
          "windows/Control.ps1"
          "windows/Task.ps1"
          "windows/Snapshot.ps1"
          "windows/GuestBuild.ps1"
          "windows/ExportArtifact.ps1"
          "windows/Registry.ps1"
          "windows/Graphics.ps1"
          "windows/LoadedIdentity.cs"
          "windows/Install.ps1"
          "windows/Rollback.ps1"
          "windows/Restore-PowerShell.ps1"
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
          "wb/devbox.py"
          "wb/graphics.py"
          "wb/windows.py"
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
    export WB_WINDOWS_TOOLS_EXPRESSION=${buildOperations}/windows-build-tools.nix
    export WB_WINDOWS_RUST_EXPRESSION=${buildOperations}/windows-rust-deps.nix
    export WB_WINDOWS_UTILITIES_EXPRESSION=${buildOperations}/windows-utilities.nix
    export WB_WINDOWS_COMPONENT_EXPRESSION=${buildOperations}/windows-component-inputs.nix
    export WB_DEVBOX_EXPRESSION=${buildOperations}/devbox.nix
    export WB_DEVBOX_PAYLOADS=${buildOperations}/windows
    export WB_XORRISO=${pkgs.xorriso}/bin/xorriso
    export WB_WIMLIB=${pkgs.wimlib}/bin/wimlib-imagex
    export WB_7ZIP=${pkgs._7zz}/bin/7zz
    export WB_DOCKER=${pkgs.docker-client}/bin/docker
    export WB_NVIDIA_CTK=${pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.nvidia-container-toolkit}/bin/nvidia-ctk"}
    export WB_NVIDIA_CDI_HOOK=${pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.nvidia-container-toolkit.tools}/bin/nvidia-cdi-hook"}
    export WB_NVIDIA_TOOLKIT_ROOT=${pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.nvidia-container-toolkit}"}
    export WB_PODMAN=${pkgs.podman}/bin/podman
    export WB_CONTAINER_HOOKS_DIR=${pkgs.emptyDirectory}
    export WB_CONTAINER_POLICY=${
      pkgs.writeText "winboat-container-policy.json" (
        builtins.toJSON {
          default = [ { type = "reject"; } ];
          transports.docker-archive."" = [ { type = "insecureAcceptAnything"; } ];
        }
      )
    }
    export WB_VNCVIEWER=${pkgs.tigervnc}/bin/vncviewer
    export WB_SSH=${pkgs.openssh}/bin/ssh
    export WB_SFTP=${pkgs.openssh}/bin/sftp
    export WB_SSH_KEYGEN=${pkgs.openssh}/bin/ssh-keygen
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
        python
        pkgs.nodejs
        pkgs.git
        pkgs.openssh
        pkgs.nix
        devenv
      ];
      text = environment + ''
        exec ${python}/bin/python3 -m wb ${arguments} "$@"
      '';
    };
in
{
  inherit environment;
  wb = command "wb" "";
  git = command "git" "git-wrapper";
}
