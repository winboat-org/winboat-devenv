{
  pkgs,
  sources,
  sysroot,
  configuration ? "release",
}:
let
  inputs = import ./clvk-inputs.nix { inherit pkgs; };
  hostTools = import ./clvk-host-tools.nix { inherit pkgs inputs; };
  libclc = import ./clvk-libclc.nix { inherit pkgs inputs hostTools; };
  loaders = import ./clvk-loaders.nix { inherit pkgs inputs sysroot; };
  compiler = import ./clvk-compiler.nix {
    inherit
      pkgs
      sources
      sysroot
      inputs
      hostTools
      libclc
      loaders
      configuration
      ;
  };
  llvm = pkgs.llvmPackages_22;
  patches = map (name: pkgs.writeText name (builtins.readFile (./. + "/${name}"))) [
    "clvk-build-directory.patch"
    "clvk-no-compiler-symbols.patch"
    "clvk-cross-warning-flags.patch"
    "clvk-clang-cl-warnings.patch"
  ];
  inspectScript = pkgs.writeText "msvc-cross-inspect.py" (builtins.readFile ../scripts/msvc-cross-inspect.py);
in
pkgs.runCommand "clvk-helios-msvc-cross-${configuration}"
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
    mkdir -p "$out"
    cp -R ${compiler}/. "$out/"
    chmod -R u+w "$out"
    mkdir -p "$out/package/x86" "$out/package/smoke/x86" "$out/licenses"
    cp ${loaders}/x64/{vulkan-1.dll,vulkan-1.pdb,OpenCL.dll,OpenCL.pdb} "$out/package/"
    cp ${loaders}/x86/{vulkan-1.dll,vulkan-1.pdb} "$out/package/x86/"
    cp ${inputs}/source-revisions.json "$out/package/source-revisions.json"
    cp ${
      pkgs.writeText "clvk-compiler-source.json" (
        builtins.toJSON {
          schemaVersion = 1;
          storePath = toString compiler;
        }
      )
    } "$out/share/winboat/compiler.json"
    cp -R ${inputs}/share/licenses/. "$out/licenses/"
    cp -R ${sysroot}/share/licenses/. "$out/licenses/"
    ${pkgs.lib.concatMapStringsSep "\n"
      (name: ''
        mkdir -p "$out/licenses/${name}"
        find ${sources.${name}} -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) \
          | while IFS= read -r notice; do
            relative="''${notice#${sources.${name}}/}"
            mkdir -p "$out/licenses/${name}/$(dirname "$relative")"
            cp "$notice" "$out/licenses/${name}/$relative"
          done
      '')
      [
        "clvk-helios"
        "helios"
      ]
    }
    python3 - "$out/package/clspv-patches.json" ${sources.helios}/ci/patches/clspv ${pkgs.lib.concatStringsSep " " patches} <<'PY'
    import hashlib, json, pathlib, sys
    paths = sorted(pathlib.Path(sys.argv[2]).glob('*.patch')) + [pathlib.Path(p) for p in sys.argv[3:]]
    pathlib.Path(sys.argv[1]).write_text(json.dumps([{'path':p.name, 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]))
    PY
    # Runtime probes retain symbols; compiler dependencies never produce them.
    for architecture in x64 x86; do
      triple=x86_64-pc-windows-msvc
      destination="$out/package/smoke"
      if [ "$architecture" = x86 ]; then
        triple=i686-pc-windows-msvc
        destination="$destination/x86"
      fi
      build_probe() {
        name="$1"; source="$2"; shift 2
        clang-cl --target="$triple" /nologo /MT /O2 /Z7 /EHsc \
          /D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH \
          /imsvc ${sysroot}/crt/include /imsvc ${sysroot}/sdk/include/ucrt \
          /imsvc ${sysroot}/sdk/include/shared /imsvc ${sysroot}/sdk/include/um \
          /clang:-ivfsoverlay /clang:${sysroot}/headers-overlay.json \
          /I${inputs}/Vulkan-Headers/include /I${inputs}/OpenCL-Headers \
          /c "$source" /Fo:"$name.obj"
        lld-link /nologo /machine:"$architecture" /subsystem:console /debug \
          /out:"$destination/$name.exe" /pdb:"$destination/$name.pdb" "$name.obj" \
          /libpath:${sysroot}/crt/lib/"$architecture" \
          /libpath:${sysroot}/sdk/lib/ucrt/"$architecture" \
          /libpath:${sysroot}/sdk/lib/um/"$architecture" kernel32.lib "$@"
      }
      build_probe vulkan-smoke ${sources.helios}/packaging/windows/probes/vulkan-smoke.c ${loaders}/"$architecture"/vulkan-1.lib
      build_probe vulkan-wsi-probe ${sources.helios}/tools/vk_surface_recreate_probe.cpp ${loaders}/"$architecture"/vulkan-1.lib user32.lib gdi32.lib
      build_probe opengl-smoke ${sources.helios}/packaging/windows/probes/opengl-smoke.c opengl32.lib gdi32.lib user32.lib
      build_probe d3d11-smoke ${sources.helios}/packaging/windows/probes/d3d11-smoke.cpp d3d11.lib dxgi.lib
      build_probe d3d12-smoke ${sources.helios}/tools/d3d12_devicecreate_probe.cpp d3d12.lib dxgi.lib dxguid.lib
      build_probe d3d12-clear ${sources.helios}/tools/d3d12_clear_probe.cpp d3d12.lib dxgi.lib dxguid.lib
      if [ "$architecture" = x64 ]; then
        build_probe opencl-smoke ${sources.helios}/packaging/windows/probes/opencl-smoke.c ${loaders}/x64/OpenCL.lib
        build_probe opencl-gl-sharing-smoke ${sources.helios}/packaging/windows/probes/opencl-gl-sharing-smoke.cpp d3d11.lib opengl32.lib gdi32.lib user32.lib
      fi
    done
    python3 ${inspectScript} "$out" ${llvm.llvm}/bin/llvm-readobj \
      > "$out/images.json"
  ''
