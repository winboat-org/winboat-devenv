{
  pkgs,
  lockFile,
  payloads ? null,
}:
let
  provision = builtins.fromJSON (builtins.readFile lockFile);
  tool = builtins.head (
    builtins.filter (item: (item.sourceKind or "") == "self-contained-ewdk") provision.tools
  );
  media = builtins.head tool.payloads;
  subset = builtins.fromJSON (builtins.readFile ./msvc-sdk.lock.json);
  manifest = pkgs.writeText "msvc-sdk-subset.json" (builtins.readFile ./msvc-sdk.lock.json);
  downloader = pkgs.writeText "msvc-sdk-download.py" (
    builtins.readFile ./scripts/msvc-sdk-download.py
  );
  configuredCA = builtins.getEnv "NIX_SSL_CERT_FILE";
  certificateBundle =
    if configuredCA != "" && builtins.pathExists configuredCA then
      pkgs.writeText "msvc-sdk-ca-bundle.crt" (builtins.readFile configuredCA)
    else
      "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
in
assert
  subset.media.sha256 == media.sha256
  && subset.media.size == media.size
  && subset.media.url == media.url;
assert subset.msvcToolset == tool.msvcToolset;
assert
  payloads == null
  ||
    builtins.hashFile "sha256" (payloads + "/provision.lock.json")
    == builtins.hashFile "sha256" lockFile;
pkgs.runCommand "winboat-msvc-sdk-subset-${subset.msvcToolset}-${subset.sdkVersion}"
  {
    nativeBuildInputs = [ pkgs.python3 ];
    SSL_CERT_FILE = certificateBundle;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = subset.narHash;
  }
  ''
    python3 ${downloader} ${manifest} "$out" ${
      pkgs.lib.optionalString (payloads != null)
        "--media ${pkgs.lib.escapeShellArg (payloads + "/files/${media.sha256}-${media.file}")}"
    }
  ''
