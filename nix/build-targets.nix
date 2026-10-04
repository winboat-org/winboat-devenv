# Serializable command contract, consumed by both wb and its MCP proxy.
let
  target = repositories: backend: abi: outputs: {
    inherit
      repositories
      backend
      abi
      outputs
      ;
    configurations = [
      "release"
      "debug"
    ];
  };
  guest =
    repositories: abi: outputs:
    (target repositories "devbox" abi outputs)
    // {
      purpose = "build";
      sourceRoot = "C:\\WinBoatDev\\src";
      buildRoot = "C:\\WinBoatDev\\build";
      execution = "durable-elevated-task";
      availability = "pending-stage-4";
    };
in
{
  schemaVersion = 1;
  targets = {
    host-stack = target [ "qemu-helios" "virglrenderer" "venus-protocol" ] "nix" "linux-x86_64" [
      "qemu"
      "renderer"
      "protocol"
    ];
    venus-protocol = target [ "venus-protocol" ] "nix" "c-wire-headers" [
      "driver-headers"
      "renderer-headers"
    ];
    virglrenderer = target [ "virglrenderer" "venus-protocol" ] "nix" "linux-x86_64" [
      "libvirglrenderer.so.1"
      "virgl_render_server"
    ];
    qemu-helios = target [ "qemu-helios" "virglrenderer" "venus-protocol" ] "nix" "linux-x86_64" [
      "qemu-system-x86_64"
      "modules"
      "firmware"
    ];
    dxvk-win64 = target [ "dxvk" ] "nix" "windows-x86_64-mingw-static-cxx-runtime" [
      "dxgi.dll"
      "d3d9.dll"
      "d3d10core.dll"
      "d3d11.dll"
    ];
    helios-protocol = target [ "helios" ] "nix" "rust-linux" [ "protocol-tests" ];
    mesa-host = target [ "mesa-helios" "venus-protocol" ] "nix" "linux-x86_64" [
      "venus-vulkan-icd"
      "zink-opengl"
    ];
    WBFreeRDP = target [ "WBFreeRDP" ] "nix" "linux-x86_64" [ "xfreerdp" ];
    dxvk-engine-x64 = guest [ "dxvk" "helios" ] "windows-x86_64-msvc-mt" [
      "libdxvk.a"
      "libhelios_d3d11_static.a"
      "libdxbc_spv.a"
      "libdisplay-info.a"
      "libspirv.a"
      "libutil.a"
      "libwsi.a"
      "libvkcommon.a"
      "pdb"
    ];
    dxvk-engine-x86 = guest [ "dxvk" "helios" ] "windows-x86-msvc-mt" [
      "libdxvk.a"
      "libhelios_d3d11_static.a"
      "libdxbc_spv.a"
      "libdisplay-info.a"
      "libspirv.a"
      "libutil.a"
      "libwsi.a"
      "libvkcommon.a"
      "pdb"
    ];
    vkd3d-engine-x64 = guest [ "vkd3d-proton" "dxil-spirv" ] "windows-x86_64-msvc-mt" [
      "libhelios_d3d12_static.a"
      "dxil-spirv"
      "pdb"
    ];
    vkd3d-engine-x86 = guest [ "vkd3d-proton" "dxil-spirv" ] "windows-x86-msvc-mt" [
      "libhelios_d3d12_static.a"
      "dxil-spirv"
      "pdb"
    ];
    helios-guest-x64 =
      guest [ "helios" "dxvk" "vkd3d-proton" "dxil-spirv" ] "windows-x86_64-msvc-mt-wdk"
        [
          "kmd-sys-inf-cat-certificate"
          "umd11"
          "umd12"
          "pdb"
        ];
    helios-guest-x86 = guest [ "helios" "dxvk" "vkd3d-proton" "dxil-spirv" ] "windows-x86-msvc-mt" [
      "umd11"
      "umd12"
      "pdb"
    ];
    helios-development-package = guest [ "helios" ] "windows-x64-wow64-development-package" [
      "bundle/manifest.json"
    ];
    mesa-guest-x64 = guest [ "mesa-helios" "venus-protocol" "helios" ] "windows-x86_64-msvc-mt" [
      "vulkan_virtio.dll"
      "opengl32.dll"
      "icd-json"
      "pdb"
    ];
    mesa-guest-x86 = guest [ "mesa-helios" "venus-protocol" "helios" ] "windows-x86-msvc-mt" [
      "vulkan_virtio.dll"
      "opengl32.dll"
      "icd-json"
      "pdb"
    ];
    # These adapters fail closed until their full fixed dependency closures exist.
    winboat =
      (target [ "winboat" "electron" ] "unavailable" "electron-linux" [
        "app"
        "guest-server"
      ])
      // {
        inherit (import ./adapters/winboat.nix) reason inputContract;
      };
    electron =
      (target [ "electron" ] "unavailable" "chromium-linux" [
        "electron"
        "symbols"
      ])
      // {
        inherit (import ./adapters/electron.nix) reason inputContract;
      };
    clvk-helios =
      (guest [ "clvk-helios" "helios" ] "windows-x86_64-msvc-mt" [
        "clvk.dll"
        "clspv"
        "OpenCL-loader"
        "pdb"
      ])
      // {
        inherit (import ./adapters/clvk.nix) reason inputContract;
      };
  };
}
