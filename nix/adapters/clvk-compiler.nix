{
  pkgs,
  sources,
  sysroot,
  inputs,
  hostTools,
  libclc,
  loaders,
  configuration ? "release",
}:
let
  toolchain = import ../msvc-toolchain.nix {
    inherit pkgs sysroot;
    architecture = "x64";
  };
  llvm = pkgs.llvmPackages_22;
  buildType = if configuration == "debug" then "Debug" else "RelWithDebInfo";
  patches = map (name: pkgs.writeText name (builtins.readFile (./. + "/${name}"))) [
    "clvk-build-directory.patch"
    "clvk-no-compiler-symbols.patch"
    "clvk-cross-warning-flags.patch"
    "clvk-clang-cl-warnings.patch"
  ];
  symbolPolicy = pkgs.writeText "clvk-symbol-policy.py" (builtins.readFile ../scripts/clvk-symbol-policy.py);
  clspvPatchDirectory = "${sources.helios}/ci/patches/clspv";
  clspvPatches = map
    (name: pkgs.writeText name (builtins.readFile "${clspvPatchDirectory}/${name}"))
    (builtins.filter (name: pkgs.lib.hasSuffix ".patch" name)
      (builtins.attrNames (builtins.readDir clspvPatchDirectory)));
in
pkgs.runCommand "clvk-helios-msvc-cross-compiler-${configuration}"
  {
    nativeBuildInputs = [
      pkgs.cmake
      pkgs.ninja
      pkgs.git
      pkgs.python3
      llvm.clang-unwrapped
      llvm.lld
      llvm.llvm
    ];
  }
  ''
    python3 - ${inputs}/llvm-revision ${sources.clvk-helios}/external/clspv/deps.json <<'PY'
    import json, pathlib, sys
    revision = pathlib.Path(sys.argv[1]).read_text().strip()
    assert sum(x['name'] == 'llvm' and x['commit'] == revision for x in json.loads(pathlib.Path(sys.argv[2]).read_text())['commits']) == 1
    PY
    cp -R ${sources.clvk-helios} source
    chmod -R u+w source
    for patch in ${pkgs.lib.concatStringsSep " " clspvPatches}; do
      git -C source/external/clspv apply --check "$patch"
      git -C source/external/clspv apply "$patch"
    done
    for patch in ${pkgs.lib.concatStringsSep " " patches}; do
      git -C source apply --check "$patch"
      git -C source apply "$patch"
    done
    cmake -S source -B build -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE=${toolchain} \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=${buildType} \
      -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_POLICY_DEFAULT_CMP0141=NEW \
      -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded \
      -DLLVM_ENABLE_PDB=OFF \
      -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
      -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
      -DCLANG_INCLUDE_TESTS=OFF -DCLANG_BUILD_EXAMPLES=OFF -DCLANG_INCLUDE_DOCS=OFF \
      -DCLSPV_BUILD_TESTS=OFF -DCLVK_CLSPV_ONLINE_COMPILER=ON -DCLVK_COMPILER_AVAILABLE=ON \
      -DCLVK_VULKAN_IMPLEMENTATION=custom -DCLVK_BUILD_TESTS=OFF -DCLVK_UNIT_TESTING=OFF -DCLVK_ENABLE_ASSERTIONS=OFF \
      -DVulkan_INCLUDE_DIRS=${inputs}/Vulkan-Headers/include -DVulkan_LIBRARIES=${loaders}/x64/vulkan-1.lib \
      -DCLSPV_LLVM_SOURCE_DIR=${inputs}/llvm/llvm -DCLSPV_CLANG_SOURCE_DIR=${inputs}/llvm/clang \
      -DCLSPV_LLVM_BINARY_DIR="$PWD/l" -DCLSPV_EXTERNAL_LIBCLC_DIR=${libclc} \
      -DLLVM_NATIVE_TOOL_DIR=${hostTools}/bin \
      -DLLVM_TABLEGEN=${hostTools}/bin/llvm-tblgen -DCLANG_TABLEGEN=${hostTools}/bin/clang-tblgen
    python3 ${symbolPolicy} build/compile_commands.json ${inputs}/llvm "$PWD/l" --preflight
    cmake --build build --target OpenCL --parallel "$NIX_BUILD_CORES"
    mkdir -p "$out/package" "$out/share/winboat"
    python3 ${symbolPolicy} build/compile_commands.json ${inputs}/llvm "$PWD/l" \
      > "$out/package/llvm-symbol-policy.json"
    cp build/src/OpenCL.dll "$out/package/clvk.dll"
    cp build/src/OpenCL.pdb "$out/package/clvk.pdb"
    cp build/compile_commands.json "$out/share/winboat/compile_commands.json"
    cp ${sysroot}/source.json "$out/share/winboat/sysroot-source.json"
  ''
