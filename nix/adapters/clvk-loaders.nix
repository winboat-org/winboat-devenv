{
  pkgs,
  inputs,
  sysroot,
}:
let
  toolchain = architecture: import ../msvc-toolchain.nix { inherit pkgs sysroot architecture; };
in
pkgs.runCommand "clvk-msvc-cross-loaders"
  {
    nativeBuildInputs = [
      pkgs.cmake
      pkgs.ninja
      pkgs.stdenv.cc
    ];
  }
  ''
    cmake -S ${inputs}/Vulkan-Headers -B headers -G Ninja \
      -DCMAKE_INSTALL_PREFIX="$PWD/headers-install" -DVULKAN_HEADERS_ENABLE_TESTS=OFF
    cmake --install headers
    ${pkgs.lib.concatMapStringsSep "\n"
      (architecture: ''
        cmake -S ${inputs}/Vulkan-Loader -B vulkan-${architecture} -G Ninja \
          -DCMAKE_TOOLCHAIN_FILE=${toolchain architecture} \
          -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded \
          -DVULKAN_HEADERS_INSTALL_DIR="$PWD/headers-install" -DBUILD_TESTS=OFF -DBUILD_WERROR=OFF
        cmake --build vulkan-${architecture} --parallel "$NIX_BUILD_CORES"
        mkdir -p "$out/${architecture}"
        cp vulkan-${architecture}/loader/vulkan-1.{dll,lib,pdb} "$out/${architecture}/"
      '')
      [
        "x64"
        "x86"
      ]
    }
    cmake -S ${inputs}/OpenCL-ICD-Loader -B opencl -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE=${toolchain "x64"} \
      -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded \
      -DOPENCL_ICD_LOADER_HEADERS_DIR=${inputs}/OpenCL-Headers -DBUILD_TESTING=OFF
    cmake --build opencl --parallel "$NIX_BUILD_CORES"
    cp opencl/OpenCL.{dll,lib,pdb} "$out/x64/"
    cp ${inputs}/source-revisions.json "$out/source-revisions.json"
    cp -R ${inputs}/share "$out/share"
  ''
