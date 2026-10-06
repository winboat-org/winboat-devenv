{
  pkgs,
  payloads ? null,
  lockFile,
}:
let
  lock = builtins.fromJSON (builtins.readFile lockFile);
  tool = builtins.head (
    builtins.filter (item: (item.sourceKind or "") == "self-contained-ewdk") lock.tools
  );
  payload = builtins.head tool.payloads;
  iso =
    if payloads != null then
      payloads + "/files/${payload.sha256}-${payload.file}"
    else
      pkgs.fetchurl {
        inherit (payload) url sha256;
        name = payload.file;
      };
  vc = "Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/${tool.msvcToolset}";
  kit = "Program Files/Windows Kits/10";
  sdk = "10.0.26100.0";
  licenses = "Program Files/Microsoft Visual Studio/2022/BuildTools/Licenses";
  prepareScript = pkgs.writeText "msvc-sysroot.py" (builtins.readFile ./scripts/msvc-sysroot.py);
in
assert
  payloads == null
  ||
    builtins.hashFile "sha256" (payloads + "/provision.lock.json")
    == builtins.hashFile "sha256" lockFile;
pkgs.runCommand "winboat-msvc-${tool.msvcToolset}-sdk-${sdk}-sysroot"
  {
    nativeBuildInputs = [
      pkgs._7zz
      pkgs.python3
    ];
  }
  ''
    printf '%s  %s\n' '${payload.sha256}' '${iso}' | sha256sum --check
    mkdir -p extracted "$out/crt/lib" "$out/sdk/lib/um" "$out/sdk/lib/ucrt" "$out/share/licenses"
    7zz x -tUdf -y -oextracted '${iso}' \
      '${vc}/include/*' '${vc}/lib/x64/*' '${vc}/lib/x86/*' \
      '${kit}/Include/${sdk}/*' \
      '${kit}/Lib/${sdk}/um/x64/*' '${kit}/Lib/${sdk}/um/x86/*' \
      '${kit}/Lib/${sdk}/ucrt/x64/*' '${kit}/Lib/${sdk}/ucrt/x86/*' \
      '${licenses}/*' > extraction.log
    cp -R 'extracted/${vc}/include' "$out/crt/include"
    cp -R 'extracted/${kit}/Include/${sdk}' "$out/sdk/include"
    for architecture in x64 x86; do
      cp -R "extracted/${vc}/lib/$architecture" "$out/crt/lib/$architecture"
      cp -R "extracted/${kit}/Lib/${sdk}/um/$architecture" "$out/sdk/lib/um/$architecture"
      cp -R "extracted/${kit}/Lib/${sdk}/ucrt/$architecture" "$out/sdk/lib/ucrt/$architecture"
    done
    cp -R 'extracted/${licenses}' "$out/share/licenses/msvc"
    python3 ${prepareScript} "$out"
    test -f "$out/crt/include/vector"
    test -f "$out/sdk/include/um/Windows.h"
    for architecture in x64 x86; do
      test -f "$out/crt/lib/$architecture/libcmt.lib"
      test -f "$out/sdk/lib/um/$architecture/kernel32.lib"
      test -f "$out/sdk/lib/ucrt/$architecture/libucrt.lib"
    done
    cat > "$out/source.json" <<'JSON'
    ${builtins.toJSON {
      schemaVersion = 1;
      ewdkSha256 = payload.sha256;
      msvcToolset = tool.msvcToolset;
      sdkDirectory = sdk;
      architectures = [
        "x64"
        "x86"
      ];
      provisionLockSha256 = builtins.hashFile "sha256" lockFile;
      input = payload.file;
    }}
    JSON
  ''
