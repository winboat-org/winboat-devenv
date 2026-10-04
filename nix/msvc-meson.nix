{
  pkgs,
  sysroot,
  architecture,
  hostWidl ? null,
}:
let
  tools = import ./msvc-cross-tools.nix { inherit pkgs sysroot architecture; };
  compiler = pkgs.writeShellScriptBin "clang-cl" ''
    export PATH=${pkgs.llvmPackages_22.lld}/bin:"$PATH"
    exec ${tools.compiler} -fuse-ld=lld /MT "$@"
  '';
  libraries = map (path: "/libpath:${sysroot}/${path}/${architecture}") [
    "crt/lib"
    "sdk/lib/ucrt"
    "sdk/lib/um"
  ];
  libraryArguments = "[" + pkgs.lib.concatStringsSep ", " (map (path: "'${path}'") libraries) + "]";
in
pkgs.writeText "msvc-${architecture}-meson-cross.ini" ''
  [binaries]
  c = '${compiler}/bin/clang-cl'
  cpp = '${compiler}/bin/clang-cl'
  c_ld = '${tools.linker}'
  cpp_ld = '${tools.linker}'
  ar = '${tools.archiver}'
  windres = '${tools.resourceTools}/bin/llvm-rc'
  rc = '${tools.resourceTools}/bin/llvm-rc'
  ${pkgs.lib.optionalString (hostWidl != null) "widl = '${hostWidl}/bin/widl'"}

  [host_machine]
  system = 'windows'
  cpu_family = '${if architecture == "x64" then "x86_64" else "x86"}'
  cpu = '${if architecture == "x64" then "x86_64" else "i686"}'
  endian = 'little'

  [properties]
  needs_exe_wrapper = true

  [built-in options]
  b_vscrt = 'mt'
  c_args = ['/Z7']
  cpp_args = ['/Z7']
  c_link_args = ${libraryArguments}
  cpp_link_args = ${libraryArguments}
''
