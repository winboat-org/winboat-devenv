{ nixpkgsPath, lockFile }:
let
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
  cargoLock = pkgs.writeText "installer-Cargo.lock" (builtins.readFile (builtins.toPath lockFile));
  vendor = pkgs.rustPlatform.importCargoLock { lockFile = cargoLock; };
in
pkgs.runCommand "helios-installer-cargo-dependencies" { } ''
  mkdir -p $out/vendor $out/licenses
  cp ${vendor}/.cargo/config.toml $out/config.toml
  cp ${cargoLock} $out/Cargo.lock
  for package in ${vendor}/*; do
    [ -d "$package" ] || continue
    name=$(basename "$package")
    cp -rL "$package" "$out/vendor/$name"
    mkdir -p "$out/licenses/$name"
    cp "$package/Cargo.toml" "$out/licenses/$name/source-attribution.toml"
    find "$package" -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) -exec cp '{}' "$out/licenses/$name/" \;
  done
''
