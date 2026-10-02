{ pkgs, sources }:
pkgs.stdenv.mkDerivation {
  pname = "winboat-venus-protocol";
  version = "1.1.3";
  src = sources.venus-protocol;
  nativeBuildInputs = [
    pkgs.meson
    pkgs.ninja
    pkgs.pkg-config
    (pkgs.python3.withPackages (p: [
      p.mako
      p.pyyaml
    ]))
  ];
  mesonBuildType = "release";
  mesonWrapMode = "nodownload";
  mesonFlags = [

  ];
  # vcs_tag otherwise loses the exact identity in an exported source snapshot.
  postPatch = ''
    substituteInPlace meson.build --replace-fail "command: ['git', 'rev-parse', '--short=8', 'HEAD']" "command: ['cat', '.wb-revision']"
  '';
  doCheck = true;
  postInstall = ''
    mkdir -p $out/share/licenses/venus-protocol
    cp ../vn_protocol.py ../templates/common.h $out/share/licenses/venus-protocol/
    cp ../xmls/*.xml $out/share/licenses/venus-protocol/
  '';
}
