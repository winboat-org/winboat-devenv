# Canonical identities and the current, migration-compatible checkout layout.
# Subset membership excludes implicit dependencies; selectors add their closure.
let
  repo = name: path: dependencies: {
    url = "https://github.com/winboat-org/${name}.git";
    inherit path dependencies;
    parent = null;
    submodulePath = null;
    submodules = {
      mode = "none";
      paths = [ ];
    };
  };
  nested =
    name: path: dependencies: parent: submodulePath:
    (repo name path dependencies) // { inherit parent submodulePath; };
  heliosRoot = "repos/helios";
in
{
  schemaVersion = 1;
  layoutVersion = 2;
  repositories = {
    helios = repo "helios" heliosRoot [
      "dxvk"
      "vkd3d-proton"
    ];
    qemu-helios = repo "qemu-helios" "repos/qemu-helios" [
      "virglrenderer"
    ];
    dxvk = (repo "dxvk" "repos/dxvk" [ ]) // {
      submodules = {
        mode = "selected";
        paths = [
          "include/native/directx"
          "include/vulkan"
          "include/spirv"
          "subprojects/libdisplay-info"
          "subprojects/dxbc-spirv"
        ];
        nested = [
          {
            parent = "subprojects/dxbc-spirv";
            path = "submodules/spirv_headers";
          }
        ];
      };
    };
    virglrenderer = repo "virglrenderer" "repos/virglrenderer" [
      "venus-protocol"
    ];
    mesa-helios = (repo "mesa-helios" "repos/mesa-helios" [ "venus-protocol" ]) // {
      submodules = {
        mode = "selected";
        paths = [ "subprojects/venus-protocol" ];
      };
    };
    vkd3d-proton =
      (repo "vkd3d-proton" "repos/vkd3d-proton" [
        "dxil-spirv"
      ])
      // {
        submodules = {
          mode = "selected";
          paths = [
            "subprojects/dxil-spirv"
            "khronos/Vulkan-Headers"
            "khronos/SPIRV-Headers"
          ];
        };
      };
    dxil-spirv =
      (nested "dxil-spirv" "repos/vkd3d-proton/subprojects/dxil-spirv" [ ] "vkd3d-proton"
        "subprojects/dxil-spirv"
      )
      // {
        submodules = {
          mode = "selected";
          paths = [
            "third_party/spirv-headers"
            "subprojects/dxbc-spirv"
          ];
          nested = [
            {
              parent = "subprojects/dxbc-spirv";
              path = "submodules/spirv_headers";
            }
          ];
        };
      };
    # Mesa owns the protocol gitlink; renderer consumption stays explicit.
    venus-protocol =
      nested "venus-protocol" "repos/mesa-helios/subprojects/venus-protocol" [ ] "mesa-helios"
        "subprojects/venus-protocol";
    winboat = repo "winboat" "repos/winboat" [ ];
    WBFreeRDP = repo "WBFreeRDP" "repos/WBFreeRDP" [ ];
    electron = repo "electron" "repos/electron" [ ];
    clvk-helios = (repo "clvk-helios" "repos/clvk-helios" [ ]) // {
      submodules = {
        mode = "selected";
        paths = [
          "external/clspv"
          "external/OpenCL-Headers"
          "external/SPIRV-Headers"
          "external/SPIRV-LLVM-Translator"
          "external/SPIRV-Tools"
        ];
      };
    };
  };
  subsets = rec {
    helios = [
      "helios"
      "qemu-helios"
      "dxvk"
      "virglrenderer"
      "mesa-helios"
      "vkd3d-proton"
    ];
    winboat = [
      "winboat"
      "WBFreeRDP"
      "electron"
    ];
    winboat-accel = winboat ++ helios ++ [ "clvk-helios" ];
  };
}
