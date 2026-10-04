{ pkgs, sysroot }:
let
  llvm = pkgs.llvmPackages_22;
in
pkgs.runCommand "winboat-msvc-cross-x64-x86-probe"
  {
    nativeBuildInputs = [
      llvm.clang-unwrapped
      llvm.lld
      llvm.llvm
    ];
  }
  ''
    for architecture in x64 x86; do
      if [ "$architecture" = x64 ]; then
        triple=x86_64-pc-windows-msvc
        machine=IMAGE_FILE_MACHINE_AMD64
      else
        triple=i686-pc-windows-msvc
        machine=IMAGE_FILE_MACHINE_I386
      fi
      mkdir -p "$out/$architecture"
      ${llvm.clang-unwrapped}/bin/clang-cl --target="$triple" /nologo /MT /O2 /Z7 /EHsc /std:c++17 \
        /D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH \
        /imsvc '${sysroot}/crt/include' /imsvc '${sysroot}/sdk/include/ucrt' \
        /imsvc '${sysroot}/sdk/include/shared' /imsvc '${sysroot}/sdk/include/um' \
        /clang:-ivfsoverlay /clang:'${sysroot}/headers-overlay.json' \
        /c ${../tests/MsvcCrossProbe.cpp} /Fo:"$out/$architecture/probe.obj"
      ${llvm.lld}/bin/lld-link /nologo /subsystem:console /machine:"$architecture" \
        /libpath:'${sysroot}/crt/lib/'"$architecture" \
        /libpath:'${sysroot}/sdk/lib/ucrt/'"$architecture" \
        /libpath:'${sysroot}/sdk/lib/um/'"$architecture" \
        /out:"$out/$architecture/probe.exe" /debug /pdb:"$out/$architecture/probe.pdb" \
        "$out/$architecture/probe.obj" kernel32.lib
      ${llvm.llvm}/bin/llvm-readobj --file-headers --coff-imports --coff-directives \
        "$out/$architecture/probe.exe" > "$out/$architecture/inspection.txt"
      ${pkgs.ripgrep}/bin/rg --quiet "$machine" "$out/$architecture/inspection.txt"
      if ${pkgs.ripgrep}/bin/rg --ignore-case --quiet \
        'Name: (msvcrt|msvcp[0-9]+|vcruntime[0-9]+|ucrtbase|api-ms-win-crt-)' \
        "$out/$architecture/inspection.txt"; then
        echo 'Dynamic CRT import violates the static CRT contract' >&2
        exit 1
      fi
    done
    cp '${sysroot}/source.json' "$out/sysroot-source.json"
  ''
