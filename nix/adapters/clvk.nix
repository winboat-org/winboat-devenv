{
  backend = "nix";
  toolchain = "linux-msvc-cross";
  adapter = "clvk-cross.nix";
  buildSystem = "CMake/Ninja";
  purpose = "build";
  inputContract = {
    schemaVersion = 1;
    required = [
      "clvk-helios"
      "clspv"
      "LLVM/Clang"
      "matching Linux LLVM generators and compiler tools"
      "external libclc Vulkan bitcode"
      "SPIRV-Tools"
      "SPIRV-Headers"
      "SPIRV-LLVM-Translator"
      "OpenCL-Headers"
      "OpenCL-loader"
    ];
    identity = "The complete compiler/gitlink closure requires immutable source and archive hashes, including clspv's nested dependencies.";
  };
  reason = "The locked Linux MSVC compiler/header/loader closure passed development builds and Windows DLL loads; full installed graphics/compute acceptance remains pending.";
}
