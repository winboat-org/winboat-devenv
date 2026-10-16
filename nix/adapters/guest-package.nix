{
  backend = "devbox";
  purpose = "build";
  architecture = "x64";
  crt = "mt";
  symbolStorage = "component-artifacts";
  commands = [
    [
      "powershell.exe"
      "-NoProfile"
      "-ExecutionPolicy"
      "Bypass"
      "-File"
      "@controlRoot@/PackageGuest.ps1"
      "-Specification"
      "@specification@"
    ]
  ];
  outputs = [ "bundle/manifest.json" ];
  preserveDirectories = [ "bundle" ];
  requirements = [
    "verified-component-manifests"
    "baseline-test-signing-certificate"
  ];
}
