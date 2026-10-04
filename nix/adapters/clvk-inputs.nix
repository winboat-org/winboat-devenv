{ pkgs }:
let
  # Exact LLVM commit from the selected clspv's deps.json; NAR hash measured by
  # nix-prefetch-git. Guest builds never execute fetch_sources.py.
  llvm = pkgs.fetchgit {
    url = "https://github.com/llvm/llvm-project.git";
    rev = "140fc5aa2a0a754db87c68b2e3861c70dd94360b";
    hash = "sha256-Yk4B1lYOCCl8EUjJeTwQ6SIkKVNghpSOIpfAw5YWIvU=";
  };
  fixed = {
    Vulkan-Loader = pkgs.fetchgit {
      url = "https://github.com/KhronosGroup/Vulkan-Loader.git";
      rev = "06830240f7a70599053f47b5f10af543e8c3daf6";
      hash = "sha256-/UYvgYTjdiW20q4MH8h36FIvhxdBfU3W9uiEuRI+yBI=";
    };
    Vulkan-Headers = pkgs.fetchgit {
      url = "https://github.com/KhronosGroup/Vulkan-Headers.git";
      rev = "11d6898377797e07dbd543aaaa367e4465074597";
      hash = "sha256-SrfDWSp7DmGHT+fM09gry9L4x6BDWxoUi3Qtbi1qg2I=";
    };
    OpenCL-ICD-Loader = pkgs.fetchgit {
      url = "https://github.com/KhronosGroup/OpenCL-ICD-Loader.git";
      rev = "18fdcd58286376124f938948aa8ed156079c1c16";
      hash = "sha256-gOmuggMDetfGhcqWiD1uxo4DIxuV29GbAbKGrNq7RNs=";
    };
    OpenCL-Headers = pkgs.fetchgit {
      url = "https://github.com/KhronosGroup/OpenCL-Headers.git";
      rev = "6fe718c31a45fe25151362a72ef041c3a1047cbd";
      hash = "sha256-qL8lFtjj+rYTsNz9RALx3pIlugAkcwclbGW7VIiijXk=";
    };
  };
in
pkgs.runCommand "clvk-windows-compiler-inputs" { nativeBuildInputs = [ pkgs.rsync ]; } ''
  mkdir -p $out/llvm $out/share/licenses/llvm
  # Tests contain deliberate Windows device names and links. Clang enters its
  # examples CMake directory unconditionally even with example targets disabled;
  # retain those sources, excluding only the disabled test/docs/benchmark trees.
  for directory in llvm clang libclc libc cmake runtimes third-party; do
    rsync -r --chmod=Du+w,Fu+w --exclude=test --exclude=tests --exclude=unittests \
      --exclude=docs --exclude=benchmarks \
      ${llvm}/"$directory" $out/llvm/
  done
  cp ${llvm}/LICENSE.TXT $out/share/licenses/llvm/
  while IFS= read -r -d "" notice; do
    relative="''${notice#"$out/llvm/"}"
    destination="$out/share/licenses/llvm/sources/$relative"
    mkdir -p "$(dirname "$destination")"
    cp "$notice" "$destination"
  done < <(find "$out/llvm" -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) -print0)
  echo 140fc5aa2a0a754db87c68b2e3861c70dd94360b > $out/llvm-revision
  cp ${
    pkgs.writeText "clvk-source-revisions.json" (
      builtins.toJSON {
        llvm = llvm.rev;
        vulkanLoader = fixed.Vulkan-Loader.rev;
        vulkanHeaders = fixed.Vulkan-Headers.rev;
        openClLoader = fixed.OpenCL-ICD-Loader.rev;
        openClHeaders = fixed.OpenCL-Headers.rev;
      }
    )
  } $out/source-revisions.json
  ${pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (name: source: ''
      cp -r ${source} $out/${name}
      mkdir -p $out/share/licenses/${name}
      cp -r ${source}/LICENSE* $out/share/licenses/${name}/
    '') fixed
  )}
''
