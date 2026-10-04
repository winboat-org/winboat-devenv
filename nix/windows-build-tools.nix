{ nixpkgsPath }:
let
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
  cross = pkgs.pkgsCross.mingwW64;
in
cross.stdenv.mkDerivation {
  pname = "winboat-windows-widl";
  inherit (cross.windows.mingw_w64_headers) version src;
  nativeBuildInputs = with pkgs; [
    autoreconfHook
    flex
    bison
  ];
  preConfigure = "cd mingw-w64-tools/widl";
  NIX_CFLAGS_LINK = "-static";
  enableParallelBuilding = true;
  dontStrip = true;
  postInstall = ''
    mkdir -p $out/share/licenses/widl
    cp -r ../../COPYING* $out/share/licenses/widl/
  '';
}
