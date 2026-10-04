{
  pkgs,
  sysroot,
  architecture,
}:
assert builtins.elem architecture [
  "x64"
  "x86"
];
let
  llvm = pkgs.llvmPackages_22;
  triple = if architecture == "x64" then "x86_64-pc-windows-msvc" else "i686-pc-windows-msvc";
  processor = if architecture == "x64" then "AMD64" else "x86";
  compilerPackage = pkgs.writeShellScriptBin "clang-cl" ''
    exec ${llvm.clang-unwrapped}/bin/clang-cl --target=${triple} \
      /D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH \
      /imsvc '${sysroot}/crt/include' /imsvc '${sysroot}/sdk/include/ucrt' \
      /imsvc '${sysroot}/sdk/include/shared' /imsvc '${sysroot}/sdk/include/um' \
      /clang:-ivfsoverlay /clang:'${sysroot}/headers-overlay.json' "$@"
  '';
  compiler = "${compilerPackage}/bin/clang-cl";
  libraryPaths = pkgs.lib.concatMapStringsSep " " (path: "/libpath:${path}/${architecture}") [
    "${sysroot}/crt/lib"
    "${sysroot}/sdk/lib/ucrt"
    "${sysroot}/sdk/lib/um"
  ];
  resourcePreprocessor = pkgs.writeShellScript "msvc-resource-preprocessor-${architecture}" ''
    exec ${llvm.clang-unwrapped}/bin/clang \
      -ivfsoverlay '${sysroot}/headers-overlay.json' \
      -isystem '${sysroot}/sdk/include/ucrt' -isystem '${sysroot}/sdk/include/shared' \
      -isystem '${sysroot}/sdk/include/um' "$@" --target=${triple}
  '';
  resourceTools = pkgs.linkFarm "msvc-resource-tools-${architecture}" [
    {
      name = "bin/llvm-rc";
      path = "${llvm.llvm}/bin/llvm-rc";
    }
    {
      name = "bin/clang";
      path = resourcePreprocessor;
    }
  ];
  assembler = pkgs.writeShellScript "llvm-ml-${architecture}" ''
    arguments=()
    for argument in "$@"; do
      if [[ "$argument" = /*.asm && -f "$argument" ]]; then
        arguments+=(/Ta "$argument")
      else
        arguments+=("$argument")
      fi
    done
    exec ${llvm.llvm}/bin/llvm-ml -m${if architecture == "x64" then "64" else "32"} "''${arguments[@]}"
  '';
in
{
  inherit
    compiler
    processor
    triple
    libraryPaths
    resourceTools
    assembler
    ;
  linker = "${llvm.lld}/bin/lld-link";
  archiver = "${llvm.llvm}/bin/llvm-lib";
  manifestTool = "${llvm.llvm}/bin/llvm-mt";
}
