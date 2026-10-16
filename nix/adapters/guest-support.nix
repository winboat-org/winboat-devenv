{
  pkgs,
  source,
  sysroot,
}:
let
  inputs = import ./khronos-inputs.nix { inherit pkgs; };
  loaders = import ./clvk-loaders.nix { inherit pkgs inputs sysroot; };
  llvm = pkgs.llvmPackages_22;
  inspectScript = ../scripts/msvc-cross-inspect.py;
in
pkgs.runCommand "helios-guest-support"
  {
    nativeBuildInputs = [
      pkgs.python3
      llvm.clang-unwrapped
      llvm.lld
    ];
  }
  ''
    mkdir -p "$out/package/x86" "$out/package/smoke/x86" "$out/licenses"
    cp ${loaders}/x64/{vulkan-1.dll,vulkan-1.pdb,OpenCL.dll,OpenCL.pdb} "$out/package/"
    cp ${loaders}/x86/{vulkan-1.dll,vulkan-1.pdb} "$out/package/x86/"
    cp ${inputs}/source-revisions.json "$out/package/source-revisions.json"
    cp -R ${inputs}/share/licenses/. "$out/licenses/"
    cp -R ${sysroot}/share/licenses/. "$out/licenses/"
    printf '%s\n' 'Probe sources migrated from winboat-org/helios d82ce565ac792eb48da5e59f2a82a12ff221851d; packaging now owned by winboat-org/winboat-devenv.' > "$out/licenses/PROBES-SOURCE-NOTICE"
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
      build_probe vulkan-smoke ${source}/packaging/windows/probes/vulkan-smoke.c ${loaders}/"$architecture"/vulkan-1.lib
      build_probe vulkan-wsi-probe ${source}/packaging/windows/probes/vk_surface_recreate_probe.cpp ${loaders}/"$architecture"/vulkan-1.lib user32.lib gdi32.lib
      build_probe opengl-smoke ${source}/packaging/windows/probes/opengl-smoke.c opengl32.lib gdi32.lib user32.lib
      build_probe d3d11-smoke ${source}/packaging/windows/probes/d3d11-smoke.cpp d3d11.lib dxgi.lib
      build_probe d3d12-smoke ${source}/packaging/windows/probes/d3d12_devicecreate_probe.cpp d3d12.lib dxgi.lib dxguid.lib
      build_probe d3d12-clear ${source}/packaging/windows/probes/d3d12_clear_probe.cpp d3d12.lib dxgi.lib dxguid.lib
      if [ "$architecture" = x64 ]; then
        build_probe opencl-smoke ${source}/packaging/windows/probes/opencl-smoke.c ${loaders}/x64/OpenCL.lib
        build_probe opencl-gl-sharing-smoke ${source}/packaging/windows/probes/opencl-gl-sharing-smoke.cpp d3d11.lib opengl32.lib gdi32.lib user32.lib
      fi
    done
    python3 ${inspectScript} "$out" ${llvm.llvm}/bin/llvm-readobj \
      > "$out/images.json"
  ''
