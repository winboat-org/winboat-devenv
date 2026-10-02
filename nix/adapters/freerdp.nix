{
  pkgs,
  sources,
  configuration,
}:
(pkgs.freerdp.override { }).overrideAttrs (old: {
  pname = "wbfreerdp";
  version = "3.30.0";
  src = sources.WBFreeRDP;
  patches = [ ];
  separateDebugInfo = true;
  cmakeFlags = (old.cmakeFlags or [ ]) ++ [
    "-DCMAKE_BUILD_TYPE=${if configuration == "debug" then "Debug" else "RelWithDebInfo"}"
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON"
  ];
  postInstall = (old.postInstall or "") + ''
    mkdir -p $out/share/licenses/WBFreeRDP
    cp ../LICENSE $out/share/licenses/WBFreeRDP/
  '';
})
