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
  layoutVersion = 1;
  repositories = {
    helios =
      (repo "helios" heliosRoot [
        "qemu-helios"
        "dxvk"
        "virglrenderer"
        "mesa-helios"
        "vkd3d-proton"
        "venus-protocol"
      ])
      // {
        submodules = {
          mode = "selected";
          paths = [
            "qemu-helios"
            "dxvk-helios"
            "virglrenderer"
            "icd/mesa"
            "vkd3d-proton-helios"
            "venus-protocol"
          ];
        };
      };
    qemu-helios = nested "qemu-helios" "${heliosRoot}/qemu-helios" [
      "virglrenderer"
    ] "helios" "qemu-helios";
    dxvk = (nested "dxvk" "${heliosRoot}/dxvk-helios" [ ] "helios" "dxvk-helios") // {
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
    virglrenderer = nested "virglrenderer" "${heliosRoot}/virglrenderer" [
      "venus-protocol"
    ] "helios" "virglrenderer";
    mesa-helios = nested "mesa-helios" "${heliosRoot}/icd/mesa" [
      "venus-protocol"
    ] "helios" "icd/mesa";
    vkd3d-proton =
      (nested "vkd3d-proton" "${heliosRoot}/vkd3d-proton-helios" [
        "dxil-spirv"
      ] "helios" "vkd3d-proton-helios")
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
      nested "dxil-spirv" "${heliosRoot}/vkd3d-proton-helios/subprojects/dxil-spirv" [ ] "vkd3d-proton"
        "subprojects/dxil-spirv";
    # Current gitlink ownership is Helios. Stage 7 moves it to Mesa together
    # with the build consumers and the layout version, as requested.
    venus-protocol =
      nested "venus-protocol" "${heliosRoot}/venus-protocol" [ ] "helios"
        "venus-protocol";
    winboat = repo "winboat" "repos/winboat" [ ];
    WBFreeRDP = repo "WBFreeRDP" "repos/WBFreeRDP" [ ];
    electron = repo "electron" "repos/electron" [ ];
    clvk-helios = repo "clvk-helios" "repos/clvk-helios" [ ];
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
