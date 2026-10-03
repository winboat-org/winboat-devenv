{ nixpkgsPath, specification }:
let
  spec = builtins.fromJSON (builtins.readFile specification);
  pkgs = import (builtins.toPath nixpkgsPath) { system = spec.system; };
  # storePath retains the exact verified Stage 2 output and its entire closure.
  # There is no distribution QEMU in this image and no mutable base-image tag.
  stack = builtins.storePath spec.hostStack;
  payloads = import ./windows-payloads.nix {
    inherit pkgs;
    lockFile = builtins.path {
      path = builtins.toPath spec.provisionLock;
      name = "provision.lock.json";
    };
    lockSha256 = spec.provisionLockSha256;
  };
  supervisor = pkgs.writeText "winboat-devbox-run.py" (builtins.readFile ./scripts/devbox-run.py);
  launch = pkgs.writeShellScriptBin "winboat-devbox" ''
    export WB_STACK=${stack}
    export WB_SWTPM=${pkgs.swtpm}/bin/swtpm
    export WB_SMBD=${pkgs.samba}/sbin/smbd
    export WB_SMBPASSWD=${pkgs.samba}/bin/smbpasswd
    export WB_NIX=${pkgs.nix}/bin/nix
    export WB_MESA=${pkgs.mesa}
    export WB_WINDOWS_PAYLOADS=${payloads}
    exec ${pkgs.python3}/bin/python3 ${supervisor}
  '';
in
assert spec.schemaVersion == 1;
assert spec.system == "x86_64-linux";
(pkgs.dockerTools.buildLayeredImage {
  name = "winboat-devbox";
  tag = spec.identity;
  created = "1970-01-01T00:00:01Z";
  contents = [
    stack
    launch
    pkgs.dockerTools.caCertificates
    (pkgs.dockerTools.fakeNss.override {
      extraPasswdLines = [ "wbdev:x:1000:1000:WinBoat:/state:/bin/false" ];
      extraGroupLines = [ "wbdev:x:1000:" ];
    })
  ];
  extraCommands = ''
    mkdir -p state workspace media tmp etc
    chmod 1777 tmp
  '';
  config = {
    Entrypoint = [ "${launch}/bin/winboat-devbox" ];
    WorkingDir = "/state";
    ExposedPorts = {
      "22/tcp" = { };
      "5900/tcp" = { };
    };
    Labels = {
      "org.winboat.host-stack" = spec.hostStack;
      "org.winboat.manifest-sha256" = spec.manifestSha256;
      "org.winboat.lock-sha256" = spec.lockSha256;
      "org.winboat.provision-lock-sha256" = spec.provisionLockSha256;
    };
  };
})
// {
  # A compressed image does not carry live store references for the GC scanner.
  # Keep the execution closure rooted separately, including the offline cache.
  winboatRuntime = launch;
}
