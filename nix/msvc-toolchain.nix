{
  pkgs,
  sysroot,
  architecture,
}:
let
  inherit (import ./msvc-cross-tools.nix { inherit pkgs sysroot architecture; })
    compiler
    processor
    libraryPaths
    resourceTools
    assembler
    linker
    archiver
    manifestTool
    ;
in
pkgs.writeText "msvc-${architecture}-toolchain.cmake" ''
  set(CMAKE_SYSTEM_NAME Windows)
  set(CMAKE_SYSTEM_PROCESSOR ${processor})
  set(CMAKE_C_COMPILER "${compiler}")
  set(CMAKE_CXX_COMPILER "${compiler}")
  set(CMAKE_LINKER "${linker}")
  set(CMAKE_AR "${archiver}")
  set(CMAKE_RC_COMPILER "${resourceTools}/bin/llvm-rc")
  set(CMAKE_MT "${manifestTool}")
  set(CMAKE_ASM_MASM_COMPILER "${assembler}")
  set(CMAKE_EXE_LINKER_FLAGS_INIT "${libraryPaths}")
  set(CMAKE_SHARED_LINKER_FLAGS_INIT "${libraryPaths}")
  set(CMAKE_MODULE_LINKER_FLAGS_INIT "${libraryPaths}")
  set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded CACHE STRING "Static MSVC CRT")
  set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)
  set(CMAKE_POLICY_DEFAULT_CMP0141 NEW)
  set(CMAKE_FIND_ROOT_PATH "${sysroot}")
  set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
  set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
  set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
  set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)
''
