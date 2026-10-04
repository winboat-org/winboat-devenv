{ pkgs }:
pkgs.runCommand "winboat-host-vulkan-probe" {
  nativeBuildInputs = [ pkgs.stdenv.cc ];
  buildInputs = [ pkgs.vulkan-headers pkgs.vulkan-loader ];
} ''
  mkdir -p $out/bin
  $CC ${./scripts/host-vulkan-probe.c} -o $out/bin/winboat-host-vulkan-probe -lvulkan
''
