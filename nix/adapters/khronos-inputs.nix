{ pkgs }:
let
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
pkgs.runCommand "winboat-khronos-inputs" { } ''
  mkdir -p $out/share/licenses
  cp ${
    pkgs.writeText "khronos-source-revisions.json" (
      builtins.toJSON {
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
