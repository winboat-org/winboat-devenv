{
  pkgs,
  lockFile,
  lockSha256,
}:
let
  lockSource = builtins.path {
    path = builtins.toPath lockFile;
    name = "provision.lock.json";
  };
  lock = builtins.fromJSON (builtins.readFile lockSource);
  locked = builtins.filter (tool: tool.status == "locked") lock.tools;
  payloads = pkgs.lib.concatMap (tool: tool.payloads) locked;
  valid =
    payload:
    builtins.match "[0-9a-f]{64}" payload.sha256 != null
    && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" payload.file != null
    && pkgs.lib.hasPrefix "https://" payload.url;
  # SDK and WDK share some identically hashed payloads. Materialize each cache
  # identity once; Nix store inputs are read-only and cannot be overwritten.
  sources = builtins.attrValues (
    builtins.listToAttrs (
      map (payload: {
        name = payload.sha256 + "-" + payload.file;
        value = {
          name = payload.sha256 + "-" + payload.file;
          source = pkgs.fetchurl {
            inherit (payload) url sha256;
            name = payload.file;
            curlOptsList = pkgs.lib.optionals (payload ? userAgent) [
              "--user-agent"
              payload.userAgent
            ];
          };
        };
      }) payloads
    )
  );
in
assert lock.schemaVersion == 1;
assert builtins.hashFile "sha256" lockSource == lockSha256;
assert builtins.all valid payloads;
pkgs.runCommand "winboat-windows-payloads" { } ''
  mkdir -p "$out/files"
  cp ${lockSource} "$out/provision.lock.json"
  ${pkgs.lib.concatMapStringsSep "\n" (source: ''
    cp ${source.source} "$out/files/${source.name}"
  '') sources}
''
