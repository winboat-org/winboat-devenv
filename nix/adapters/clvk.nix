{
  backend = "devbox";
  buildSystem = "CMake/Ninja";
  purpose = "build";
  inputContract = {
    schemaVersion = 1;
    required = [
      "clvk-helios"
      "clspv"
      "LLVM/Clang"
      "SPIRV-Tools"
      "SPIRV-Headers"
      "SPIRV-LLVM-Translator"
      "OpenCL-Headers"
      "OpenCL-loader"
    ];
    identity = "The complete compiler/gitlink closure requires immutable source and archive hashes, including clspv's nested dependencies.";
  };
  reason = "Fixed compiler/header/translator inputs and the Stage 4 guest backend are unavailable; no compiler or downloads were run.";
}
