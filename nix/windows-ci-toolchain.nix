{
  nixpkgsPath,
  lockFile,
  payloads ? null,
}:
let
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
  lock = builtins.fromJSON (builtins.readFile (builtins.toPath lockFile));
  tool = id: builtins.head (builtins.filter (t: t.id == id) lock.tools);
  fetch = p: pkgs.fetchurl { inherit (p) url sha256; };
  msvc = import ./msvc-sdk-source.nix {
    inherit pkgs;
    payloads = if payloads == null then null else builtins.storePath (toString payloads);
    lockFile = builtins.toPath lockFile;
    subsetFile = ./msvc-tools.lock.json;
  };
  selections = {
    windows-sdk = [
      "Universal_CRT_Headers_Libraries_and_Sources-x86_en-us.msi"
      "Windows_SDK_for_Windows_Store_Apps_Headers-x86_en-us.msi"
      "Windows_SDK_for_Windows_Store_Apps_Libs-x86_en-us.msi"
      "Windows_SDK_Desktop_Headers_x86-x86_en-us.msi"
      "Windows_SDK_Desktop_Headers_x64-x86_en-us.msi"
      "Windows_SDK_OnecoreUap_Headers_x86-x86_en-us.msi"
      "Windows_SDK_OnecoreUap_Headers_x64-x86_en-us.msi"
      "Windows_SDK_Desktop_Libs_x86-x86_en-us.msi"
      "Windows_SDK_Desktop_Libs_x64-x86_en-us.msi"
      "Windows_SDK_Signing_Tools-x86_en-us.msi"
      "Windows_SDK_Desktop_Tools_x64-x86_en-us.msi"
      "Windows_SDK_Desktop_Tools_x86-x86_en-us.msi"
      "Windows_SDK_EULA-x86_en-us.msi"
    ];
    windows-wdk = [
      "Windows_Driver_Kit_Headers_and_Libs-x86_en-us.msi"
      "Windows_Driver_Kit_Headers_and_Libs_OnecoreUAP-x86_en-us.msi"
      "Windows_Driver_Kit_Binaries-x86_en-us.msi"
      "Windows_Driver_Kit_Binaries_OnecoreUAP-x86_en-us.msi"
      "Windows_Driver_Kit_SxS_Content-x86_en-us.msi"
    ];
  };
  kit =
    id:
    let
      descriptor = tool id;
      selected = map (
        name: builtins.head (builtins.filter (p: p.file == name) descriptor.payloads)
      ) selections.${id};
      media =
        p:
        builtins.fromJSON (
          builtins.readFile (
            pkgs.runCommand "${p.file}-media.json"
              {
                nativeBuildInputs = [
                  pkgs.msitools
                  pkgs.python3
                ];
              }
              ''
                msiinfo export ${fetch p} Media > media.tsv
                python3 - "$out" <<'PY'
                import csv,json,pathlib,sys
                rows=list(csv.reader(open('media.tsv'),delimiter='\t'))
                pathlib.Path(sys.argv[1]).write_text(json.dumps([r[3] for r in rows[3:] if len(r)>3 and r[3] and not r[3].startswith('#')]))
                PY
              ''
          )
        );
      cabinetNames = pkgs.lib.unique (pkgs.lib.concatMap media selected);
      cabinets = map (
        name:
        builtins.head (
          builtins.filter (p: builtins.baseNameOf (p.relativePath or p.file) == name) descriptor.payloads
        )
      ) cabinetNames;
      inputs = selected ++ cabinets;
    in
    pkgs.runCommand "winboat-portable-${id}-${descriptor.version}"
      {
        nativeBuildInputs = [ pkgs.msitools ];
      }
      ''
            mkdir -p layout unpack "$out/kits" "$out/licenses"
            ${pkgs.lib.concatMapStringsSep "\n" (
              p: "cp ${fetch p} layout/${pkgs.lib.escapeShellArg (builtins.baseNameOf p.relativePath)}"
            ) inputs}
            cd layout
            ${pkgs.lib.concatMapStringsSep "\n" (
              p: "msiextract -C ../unpack ${pkgs.lib.escapeShellArg (builtins.baseNameOf p.relativePath)}"
            ) selected}
            cd ..
        find unpack -type d -path '*/Windows Kits/10' -print0 > roots
        test -s roots
        while IFS= read -r -d "" kit_root; do
          cp -R "$kit_root"/. "$out/kits/"
          chmod -R u+w "$out/kits"
        done < roots
            cp ${
              pkgs.writeText "${id}-sources.json" (
                builtins.toJSON {
                  inherit (descriptor) id version;
                  payloads = inputs;
                }
              )
            } "$out/licenses/${id}-sources.json"
            find unpack -type f \( -iname '*eula*' -o -iname '*license*' -o -iname '*notice*' \) -exec cp '{}' "$out/licenses/" \;
      '';
  rust = tool "rust";
  rustArchives = builtins.filter (
    p: pkgs.lib.hasSuffix ".tar.xz" p.file && p.file != "rust-src-nightly.tar.xz"
  ) rust.payloads;
  llvm = builtins.head (tool "llvm").payloads;
in
pkgs.runCommand "winboat-hosted-windows-toolchain"
  {
    nativeBuildInputs = [
      pkgs._7zz
      pkgs.xz
    ];
  }
  ''
      mkdir -p "$out/kits" "$out/rust/bin" "$out/licenses" "$out/llvm"
      cp -R ${msvc}/. "$out/"
      for kit in ${kit "windows-sdk"} ${kit "windows-wdk"}; do
      cp -R "$kit/kits"/. "$out/kits/"
      cp -R "$kit/licenses"/. "$out/licenses/"
      chmod -R u+w "$out/kits" "$out/licenses"
      done
      7zz x -y ${fetch llvm} -o"$out/llvm" > llvm-extraction.log
    test -f "$out/llvm/bin/libclang.dll" || { echo 'Portable LLVM libclang.dll missing'; exit 1; }
      ${pkgs.lib.concatMapStringsSep "\n" (p: ''
        mkdir rust-unpack
        tar -xJf ${fetch p} -C rust-unpack
        component=$(find rust-unpack -mindepth 2 -maxdepth 2 -type d -name 'rust*' -o -name cargo)
        cp -R "$component"/. "$out/rust/"
        find rust-unpack -maxdepth 2 -type f \( -iname 'LICENSE*' -o -iname 'COPYRIGHT*' \) -exec cp '{}' "$out/licenses/" \;
        rm -r rust-unpack
      '') rustArchives}
    for required in rust/bin/rustc.exe rust/bin/cargo.exe kits/Include/10.0.26100.0/km/ntddk.h kits/Lib/10.0.26100.0/km/x64/ntoskrnl.lib kits/bin/10.0.26100.0/x86/Inf2Cat.exe; do
      test -f "$out/$required" || { echo "Portable toolchain member missing: $required"; find "$out/kits/bin" -iname '*inf2cat*'; exit 1; }
    done
    cp ${fetch (builtins.head (tool "python").payloads)} "$out/python-installer.exe"
      cp ${
        pkgs.writeText "native-toolchain.json" (
          builtins.toJSON {
            schemaVersion = 1;
            kind = "winboat-hosted-windows-toolchain";
            sdkVersion = "10.0.26100.0";
            msvcToolset = (tool "vs-build-tools").msvcToolset;
            compilerFileVersion = (tool "vs-build-tools").compilerFileVersion;
            rustVersion = rust.version;
            llvmVersion = (tool "llvm").version;
            provisionLockSha256 = builtins.hashFile "sha256" (builtins.toPath lockFile);
            msvcSubsetNarHash = (builtins.fromJSON (builtins.readFile ./msvc-tools.lock.json)).narHash;
          }
        )
      } "$out/toolchain.json"
  ''
