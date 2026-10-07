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
  source = import ./msvc-sdk-source.nix { inherit pkgs lockFile payloads; };
  subset = builtins.fromJSON (builtins.readFile ./msvc-sdk.lock.json);
  sdk = "10.0.26100.0";
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
      pkgs.python3
    ];
  }
  ''
    mkdir -p "$out"
    cp -R --no-preserve=mode ${source}/. "$out/"
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
      sdkSubsetNarHash = subset.narHash;
      sourceIntegrity = "verified-sdk-subset-from-locked-ewdk";
    }}
    JSON
  ''
