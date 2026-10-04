{ pkgs, inputs }:
let
  tools = [
    "clang"
    "opt"
    "llvm-link"
    "llvm-tblgen"
    "llvm-min-tblgen"
    "clang-tblgen"
  ];
in
pkgs.stdenv.mkDerivation {
  pname = "clvk-llvm-host-tools";
  version = "23-140fc5aa";
  src = inputs + "/llvm";
  sourceRoot = "llvm/llvm";
  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.python3
  ];
  cmakeFlags = [
    "-GNinja"
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"
    "-DLLVM_ENABLE_PROJECTS=clang"
    "-DLLVM_TARGETS_TO_BUILD="
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_EXAMPLES=OFF"
    "-DLLVM_INCLUDE_BENCHMARKS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DCLANG_INCLUDE_TESTS=OFF"
    "-DCLANG_BUILD_EXAMPLES=OFF"
    "-DCLANG_INCLUDE_DOCS=OFF"
    "-DLLVM_ENABLE_TERMINFO=OFF"
    "-DLLVM_ENABLE_ZLIB=OFF"
    "-DLLVM_ENABLE_ZSTD=OFF"
    "-DLLVM_ENABLE_LIBXML2=OFF"
    "-DLLVM_ENABLE_LIBEDIT=OFF"
    "-DLLVM_ENABLE_PDB=OFF"
    "-DLLVM_DISTRIBUTION_COMPONENTS=${
      pkgs.lib.concatStringsSep ";" (
        (builtins.filter (tool: tool != "llvm-min-tblgen") tools)
        ++ [
          "cmake-exports"
          "llvm-headers"
          "clang-resource-headers"
        ]
      )
    }"
  ];
  env.NIX_CFLAGS_COMPILE = "-O2 -g0";
  buildPhase = ''
    runHook preBuild
    ninja -j "$NIX_BUILD_CORES" ${pkgs.lib.concatStringsSep " " tools}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    ninja install-distribution
    # LLVM's internal minimal generator deliberately has no install target.
    cp bin/llvm-min-tblgen "$out/bin/llvm-min-tblgen"
    mkdir -p "$out/share/licenses/llvm" "$out/share/winboat"
    cp -R ${inputs}/share/licenses/llvm/. "$out/share/licenses/llvm/"
    cp ${inputs}/llvm-revision "$out/share/winboat/llvm-revision"
    cp compile_commands.json "$out/share/winboat/compile_commands.json"
    runHook postInstall
  '';
}
