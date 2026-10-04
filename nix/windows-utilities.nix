{ nixpkgsPath }:
let
  pkgs = import (builtins.toPath nixpkgsPath) { system = "x86_64-linux"; };
  cmake = pkgs.fetchurl {
    url = "https://github.com/Kitware/CMake/releases/download/v4.0.3/cmake-4.0.3-windows-x86_64.zip";
    hash = "sha256-tZox37+jdqSq6p/1YP8rKfeO5fn7FUR/xxrnv5/qk3k=";
  };
  parsers = pkgs.fetchurl {
    url = "https://github.com/lexxmark/winflexbison/releases/download/v2.5.25/win_flex_bison-2.5.25.zip";
    hash = "sha256-jTJLYr4zYEssRa0d00q5PXIlNESPVaFspykt4ytqwTU=";
  };
  parserSource = pkgs.fetchzip {
    url = "https://github.com/lexxmark/winflexbison/archive/refs/tags/v2.5.25.tar.gz";
    sha256 = "06d1gslyp0gjy5j2bazhr6glwl85y98h8nxk3b9hmqsas9zmrdp3";
  };
  python = pkgs.python3.withPackages (p: [
    p.mako
    p.markupsafe
    p.packaging
    p.pyyaml
  ]);
in
pkgs.runCommand "winboat-windows-utilities" { nativeBuildInputs = [ pkgs.unzip ]; } ''
  mkdir -p $out/bin $out/python $out/share/licenses
  unzip -q ${cmake} -d cmake
  cp -r cmake/cmake-4.0.3-windows-x86_64/. $out/
  unzip -q ${parsers} -d parsers
  cp -r parsers/. $out/bin/
  mv $out/bin/win_flex.exe $out/bin/win_flex-native.exe
  mkdir -p $out/scripts
  cp ${./scripts/windows-win-flex.py} $out/scripts/windows-win-flex.py
  printf '@python.exe "%%~dp0..\\scripts\\windows-win-flex.py" %%*\r\n' > $out/bin/win_flex.cmd
  mkdir -p $out/share/licenses/winflexbison
  cp ${parserSource}/COPYING* ${parserSource}/README.md $out/share/licenses/winflexbison/
  cp ${parserSource}/flex/src/COPYING $out/share/licenses/winflexbison/FLEX-COPYING
  cp ${parserSource}/bison/src/COPYING $out/share/licenses/winflexbison/BISON-COPYING
  cp -r $out/doc/cmake $out/share/licenses/cmake
  # These modules have complete pure Python implementations. The pinned guest
  # Python executes these sources, without Linux accelerators or bytecode.
  cp -rL ${python}/${pkgs.python3.sitePackages}/. $out/python/
  chmod -R u+w $out
  find $out/python -type f \( -name '*.so' -o -name '*.pyc' \) -delete
  for info in $out/python/*.dist-info; do
    mkdir -p $out/share/licenses/$(basename "$info")
    cp -r "$info"/. $out/share/licenses/$(basename "$info")/
  done
''
