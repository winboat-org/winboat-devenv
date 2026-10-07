{ pkgs, lockFile }:
let
  provision = builtins.fromJSON (builtins.readFile lockFile);
  rust = builtins.head (builtins.filter (tool: tool.id == "rust") provision.tools);
  metadata = builtins.head (
    builtins.filter (payload: payload.file == "channel-rust-nightly.toml") rust.payloads
  );
  manifestFile = pkgs.fetchurl { inherit (metadata) url sha256; };
  manifest = builtins.fromTOML (builtins.readFile manifestFile);
  archives =
    map
      (
        selection:
        let
          payload = manifest.pkg.${selection.package}.target.${selection.target};
        in
        pkgs.fetchurl {
          url = payload.xz_url;
          sha256 = payload.xz_hash;
        }
      )
      [
        {
          package = "rustc";
          target = "x86_64-unknown-linux-gnu";
        }
        {
          package = "cargo";
          target = "x86_64-unknown-linux-gnu";
        }
        {
          package = "rust-std";
          target = "x86_64-unknown-linux-gnu";
        }
        {
          package = "rust-std";
          target = "x86_64-pc-windows-msvc";
        }
      ];
in
assert rust.version == "nightly-2026-07-14";
pkgs.stdenv.mkDerivation {
  pname = "helios-release-rust-toolchain";
  version = rust.version;
  dontUnpack = true;
  nativeBuildInputs = [
    pkgs.autoPatchelfHook
    pkgs.xz
  ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
    pkgs.curl
    pkgs.openssl
  ];
  installPhase = ''
    mkdir -p "$out"
    for archive in ${pkgs.lib.concatStringsSep " " archives}; do
      mkdir unpack
      tar -xJf "$archive" -C unpack
      installer=$(find unpack -mindepth 2 -maxdepth 2 -name install.sh)
      bash "$installer" --prefix="$out" --disable-ldconfig
      rm -r unpack
    done
  '';
}
