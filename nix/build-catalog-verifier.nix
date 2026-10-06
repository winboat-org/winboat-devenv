{ nixpkgsPath, specification }:
let
  common = import ./windows-release-tool.nix { inherit nixpkgsPath specification; };
  inherit (common) spec src tools;
in
assert spec.target == "helios-catalog-verifier";
common.build {
  notice = "Source attribution: winboat-org/winboat-devenv packaging/windows/verify-catalog.c.";
  commands = ''
    ${tools.compiler} /nologo /c /MT /Z7 /O2 /FoVerifyCatalog.obj ${src}/packaging/windows/verify-catalog.c
    ${tools.linker} /nologo /machine:x64 /subsystem:console /debug:full /pdb:$out/symbols/VerifyCatalog.pdb \
      /out:$out/VerifyCatalog.exe ${tools.libraryPaths} VerifyCatalog.obj wintrust.lib crypt32.lib
  '';
}
