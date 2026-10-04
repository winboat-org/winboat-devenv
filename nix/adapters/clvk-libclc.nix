{
  pkgs,
  inputs,
  hostTools,
}:
pkgs.runCommand "clvk-libclc-23-140fc5aa"
  {
    nativeBuildInputs = [
      pkgs.cmake
      pkgs.ninja
      pkgs.stdenv.cc
    ];
  }
  ''
    for triple in spirv32-unknown-vulkan spirv64-unknown-vulkan; do
      cmake -S ${inputs}/llvm/libclc -B "$triple" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CLC_COMPILER=${hostTools}/bin/clang \
        -DLLVM_CMAKE_DIR=${hostTools}/lib/cmake/llvm \
        -DLLVM_DEFAULT_TARGET_TRIPLE="$triple"
      cmake --build "$triple" --parallel "$NIX_BUILD_CORES"
      mkdir -p "$out/$triple"
      cp "$triple/$triple/libclc.bc" "$out/$triple/libclc.bc"
    done
    mkdir -p "$out/share/winboat"
    cp ${inputs}/llvm-revision "$out/share/winboat/llvm-revision"
  ''
