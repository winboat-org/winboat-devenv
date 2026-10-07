{ nixpkgsPath, specification }:
let
  common = import ./windows-release-tool.nix { inherit nixpkgsPath specification; };
  inherit (common)
    spec
    pkgs
    src
    tools
    ;
  rust = import ./release-rust-toolchain.nix {
    inherit pkgs;
    lockFile = builtins.toPath spec.msvc.lockFile;
  };
  vendor = import ./installer-dependencies.nix {
    inherit nixpkgsPath;
    lockFile = src + "/installer/Cargo.lock";
  };
  profile = if spec.configuration == "debug" then "debug" else "release";
in
assert spec.target == "helios-installer";
common.build {
  notice = "Source attribution: winboat-org/helios installer, migrated to winboat-org/winboat-devenv. See migration/helios-installer-source.json for the exact source identity.";
  commands = ''
    cp -R ${src}/installer installer
    chmod -R u+w installer
    export CARGO_HOME="$TMPDIR/cargo-home" CARGO_TARGET_DIR="$TMPDIR/cargo-target"
    mkdir -p "$CARGO_HOME"
    sed 's|directory = "cargo-vendor-dir"|directory = "${vendor}/vendor"|' ${vendor}/config.toml > "$CARGO_HOME/config.toml"
    export CARGO_NET_OFFLINE=true
    export PATH="${rust}/bin:${pkgs.stdenv.cc}/bin:$PATH"
    export RUSTC=${rust}/bin/rustc
    export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=${tools.linker}
    export CC_x86_64_pc_windows_msvc=${tools.compiler}
    export AR_x86_64_pc_windows_msvc=${tools.archiver}
    export HELIOS_RC_COMPILER=${tools.resourceTools}/bin/llvm-rc
    export CARGO_PROFILE_RELEASE_DEBUG=1 CARGO_PROFILE_RELEASE_STRIP=none
    export RUSTFLAGS="-C target-feature=+crt-static ${
      pkgs.lib.concatMapStringsSep " " (argument: "-C link-arg=" + argument) (
        pkgs.lib.splitString " " tools.libraryPaths
      )
    }"
    ${rust}/bin/rustc --version > "$out/toolchain.txt"
    ${rust}/bin/cargo build --manifest-path installer/Cargo.toml --locked --offline \
      --target x86_64-pc-windows-msvc ${pkgs.lib.optionalString (profile == "release") "--release"}
    cp "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/${profile}/HeliosSetup.exe" "$out/"
    cp "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/${profile}/HeliosSetup.pdb" "$out/symbols/"
    cp -R ${vendor}/licenses/. "$out/licenses/"
    ${pkgs.llvmPackages_22.llvm}/bin/llvm-readobj --file-headers "$out/HeliosSetup.exe" > headers.txt
    grep -q 'Subsystem: IMAGE_SUBSYSTEM_WINDOWS_GUI' headers.txt
    cp ${src}/installer/src/installer.manifest "$out/installer.manifest"
  '';
}
