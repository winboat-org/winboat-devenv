{ pkgs, inputs }:
let
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
          "msvc-sysroot.nix"
          "msvc-sdk-source.nix"
          "msvc-sdk.lock.json"
          "msvc-toolchain.nix"
          "msvc-cross-tools.nix"
          "msvc-meson.nix"
          "dispatch.nix"
          "host-smoke.nix"
          "host-vulkan-probe.nix"
          "host-widl.nix"
          "installer-dependencies.nix"
          "windows-release-tool.nix"
          "build-adl-compatibility.nix"
          "build-catalog-verifier.nix"
          "build-helios-installer.nix"
          "release-rust-toolchain.nix"
          "scripts/host-smoke.py"
          "scripts/host-vulkan-probe.c"
          "scripts/msvc-sysroot.py"
          "scripts/msvc-sdk-download.py"
          "scripts/clvk-symbol-policy.py"
          "scripts/msvc-cross-inspect.py"
          "devbox.nix"
          "windows-payloads.nix"
          "windows-build-tools.nix"
          "windows-rust-deps.nix"
          "windows-utilities.nix"
          "windows-component-inputs.nix"
          "scripts/devbox-run.mjs"
          "scripts/windows-win-flex.py"
          "windows/Bootstrap.ps1"
          "windows/PowerPolicy.ps1"
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
          "windows/RegistryProjection.ps1"
          "windows/Graphics.ps1"
          "windows/LoadedIdentity.cs"
          "windows/Install.ps1"
          "windows/Bundle.ps1"
          "windows/VerifyInstaller.ps1"
          "windows/ReleaseComponent.ps1"
          "windows/Rollback.ps1"
          "windows/Restore-PowerShell.ps1"
          "adapters/venus-protocol.nix"
          "adapters/freerdp.nix"
          "adapters/winboat.nix"
          "adapters/electron.nix"
          "adapters/clvk.nix"
          "adapters/clvk-inputs.nix"
          "adapters/clvk-host-tools.nix"
          "adapters/clvk-libclc.nix"
          "adapters/clvk-loaders.nix"
          "adapters/clvk-cross.nix"
          "adapters/clvk-compiler.nix"
          "adapters/clvk-build-directory.patch"
          "adapters/clvk-no-compiler-symbols.patch"
          "adapters/clvk-cross-warning-flags.patch"
          "adapters/clvk-clang-cl-warnings.patch"
        ]
  );
  devenv = inputs.devenv-cli.packages.${pkgs.stdenv.hostPlatform.system}.default;
  operationSources = import ../control-sources.nix { inherit pkgs; };
  releaseEnvironment = ''
    export WB_REAL_GIT=${pkgs.git}/bin/git
    export WB_GH=${pkgs.gh}/bin/gh
    export WB_MANIFEST_FILE=${manifest}
    export WB_NODE=${pkgs.nodejs}/bin/node
    export WB_XZ=${pkgs.xz}/bin/xz
  '';
  buildEnvironment = ''
    export WB_NIX_STORE=${pkgs.nix}/bin/nix-store
    export WB_INSTALLER_DEPS_EXPRESSION=${buildOperations}/installer-dependencies.nix
    export WB_ADL_COMPATIBILITY_EXPRESSION=${buildOperations}/build-adl-compatibility.nix
    export WB_CATALOG_VERIFIER_EXPRESSION=${buildOperations}/build-catalog-verifier.nix
    export WB_INSTALLER_CROSS_EXPRESSION=${buildOperations}/build-helios-installer.nix
    export WB_FLOCK=${pkgs.util-linux}/bin/flock
    export WB_OPERATION_SOURCES=${operationSources}
    export WB_BUILD_TARGETS=${buildTargets}
    export WB_BUILD_EXPRESSION=${buildOperations}/build.nix
    export WB_DISPATCH_EXPRESSION=${buildOperations}/dispatch.nix
    export WB_WINDOWS_TOOLS_EXPRESSION=${buildOperations}/windows-build-tools.nix
    export WB_WINDOWS_RUST_EXPRESSION=${buildOperations}/windows-rust-deps.nix
    export WB_WINDOWS_UTILITIES_EXPRESSION=${buildOperations}/windows-utilities.nix
    export WB_WINDOWS_COMPONENT_EXPRESSION=${buildOperations}/windows-component-inputs.nix
    export WB_DEVBOX_PAYLOADS=${buildOperations}/windows
    export WB_NIX=${pkgs.nix}/bin/nix
    export WB_NIXPKGS=${pkgs.path}
    export WB_SYSTEM=${pkgs.stdenv.hostPlatform.system}
    export WB_OBJDUMP=${pkgs.binutils}/bin/objdump
    export WB_READELF=${pkgs.binutils}/bin/readelf
  '';
  windowsClientEnvironment = ''
    export WB_DOCKER=${pkgs.docker-client}/bin/docker
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
    export WB_SSH=${pkgs.openssh}/bin/ssh
    export WB_SFTP=${pkgs.openssh}/bin/sftp
    export WB_SSH_KEYGEN=${pkgs.openssh}/bin/ssh-keygen
  '';
  developmentEnvironment = ''
    export WB_AGENT_RUNTIME=${import ../agent-runtime.nix { inherit pkgs inputs; }}
    export WB_DEVENV=${devenv}/bin/devenv
    export WB_MCP_SERVER=${operationSources}/mcp/server.mjs
    export WB_DEVBOX_EXPRESSION=${buildOperations}/devbox.nix
    export WB_XORRISO=${pkgs.xorriso}/bin/xorriso
    export WB_WIMLIB=${pkgs.wimlib}/bin/wimlib-imagex
    export WB_7ZIP=${pkgs._7zz}/bin/7zz
    export WB_NVIDIA_CTK=${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.nvidia-container-toolkit}/bin/nvidia-ctk"}
    export WB_NVIDIA_CDI_HOOK=${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.nvidia-container-toolkit.tools}/bin/nvidia-cdi-hook"}
    export WB_NVIDIA_TOOLKIT_ROOT=${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "${pkgs.nvidia-container-toolkit}"}
    export WB_GRAPHICS_LIBRARIES=${
      pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
        pkgs.lib.makeLibraryPath [
          pkgs.libglvnd
          pkgs.libx11
          pkgs.libxext
        ]
      )
    }
    export WB_VNCVIEWER=${pkgs.tigervnc}/bin/vncviewer
    export WB_COMMAND="$0"
  '';
  environment =
    releaseEnvironment + buildEnvironment + windowsClientEnvironment + developmentEnvironment;
  componentCommand =
    windowsBuild:
    pkgs.writeShellApplication {
      name = if windowsBuild then "wb-windows-component-build" else "wb-component-build";
      runtimeInputs = [
        pkgs.nodejs
        pkgs.git
        pkgs.nix
        pkgs.gh
      ];
      text =
        releaseEnvironment
        + buildEnvironment
        + (if windowsBuild then windowsClientEnvironment else "")
        + ''
          export WB_COMMAND="$0"
          exec ${pkgs.nodejs}/bin/node ${operationSources}/wb/release-producer.mjs "$@"
        '';
    };
  command =
    name: arguments:
    pkgs.writeShellApplication {
      inherit name;
      runtimeInputs = [
        pkgs.nodejs
        pkgs.git
        pkgs.openssh
        pkgs.nix
        devenv
      ];
      text = environment + ''
        exec ${pkgs.nodejs}/bin/node ${operationSources}/wb/cli.mjs ${arguments} "$@"
      '';
    };
in
{
  inherit environment operationSources releaseEnvironment;
  component = componentCommand false;
  windowsComponent = componentCommand true;
  sourceSync = pkgs.writeShellApplication {
    name = "wb-source-sync";
    runtimeInputs = [
      pkgs.nodejs
      pkgs.git
    ];
    text = releaseEnvironment + ''
      export WB_FLOCK=${pkgs.util-linux}/bin/flock
      if [[ -n "''${GH_TOKEN:-}''${GITHUB_TOKEN:-}" ]]; then
        credential_index="''${GIT_CONFIG_COUNT:-0}"
        export "GIT_CONFIG_KEY_''${credential_index}=credential.https://github.com.helper"
        export "GIT_CONFIG_VALUE_''${credential_index}=!${pkgs.gh}/bin/gh auth git-credential"
        export GIT_CONFIG_COUNT="$((credential_index + 1))"
        export GIT_TERMINAL_PROMPT=0
      fi
      exec ${pkgs.nodejs}/bin/node ${operationSources}/wb/cli.mjs repo sync "$@"
    '';
  };
  wb = command "wb" "";
  git = command "git" "git-wrapper";
}
