{ pkgs }:
let
  headers = pkgs.pkgsCross.mingwW64.windows.mingw_w64_headers;
in
pkgs.stdenv.mkDerivation {
  pname = "winboat-host-widl";
  inherit (headers) version src;
  nativeBuildInputs = [
    pkgs.autoreconfHook
    pkgs.flex
    pkgs.bison
  ];
  preConfigure = "cd mingw-w64-tools/widl";
  configureFlags = [
    "--target=x86_64-w64-mingw32"
    "--with-widl-includedir=${placeholder "out"}/include"
  ];
  enableParallelBuilding = true;
  postInstall = ''
    ln -s x86_64-w64-mingw32-widl "$out/bin/widl"
    cp -r ../../mingw-w64-headers/include "$out/include"
    mkdir -p "$out/share/licenses/widl"
    cp -r ../../COPYING* "$out/share/licenses/widl/"
  '';
}
