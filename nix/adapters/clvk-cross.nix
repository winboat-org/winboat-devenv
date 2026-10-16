{
  pkgs,
  sources,
  sysroot,
  configuration ? "release",
}:
let
  inputs = import ./clvk-inputs.nix { inherit pkgs; };
  hostTools = import ./clvk-host-tools.nix { inherit pkgs inputs; };
  libclc = import ./clvk-libclc.nix { inherit pkgs inputs hostTools; };
  loaders = import ./clvk-loaders.nix { inherit pkgs inputs sysroot; };
  compiler = import ./clvk-compiler.nix {
    inherit
      pkgs
      sources
      sysroot
      inputs
      hostTools
      libclc
      loaders
      configuration
      ;
  };
  llvm = pkgs.llvmPackages_22;
  patches = map (name: pkgs.writeText name (builtins.readFile (./. + "/${name}"))) [
    "clvk-build-directory.patch"
    "clvk-no-compiler-symbols.patch"
    "clvk-cross-warning-flags.patch"
    "clvk-clang-cl-warnings.patch"
  ];
  inspectScript = pkgs.writeText "msvc-cross-inspect.py" (
    builtins.readFile ../scripts/msvc-cross-inspect.py
  );
in
pkgs.runCommand "clvk-helios-msvc-cross-${configuration}"
  {
    nativeBuildInputs = [
      pkgs.cmake
      pkgs.ninja
      pkgs.git
      pkgs.python3
      llvm.clang-unwrapped
      llvm.lld
      llvm.llvm
    ];
  }
  ''
    mkdir -p "$out"
    cp -R ${compiler}/. "$out/"
    chmod -R u+w "$out"
    mkdir -p "$out/licenses" "$out/share/winboat"
    cp ${inputs}/source-revisions.json "$out/package/source-revisions.json"
    cp -R ${inputs}/share/licenses/. "$out/licenses/"
    cp -R ${sysroot}/share/licenses/. "$out/licenses/"
    cp ${sources.clvk-helios}/LICENSE "$out/licenses/CLVK-LICENSE"
    python3 - "$out/package/clspv-patches.json" ${sources.clvk-helios}/nix/patches/clspv ${pkgs.lib.concatStringsSep " " patches} <<'PY'
    import hashlib, json, pathlib, sys
    paths = sorted(pathlib.Path(sys.argv[2]).glob('*.patch')) + [pathlib.Path(p) for p in sys.argv[3:]]
    pathlib.Path(sys.argv[1]).write_text(json.dumps([{'path':p.name, 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]))
    PY
    python3 ${inspectScript} "$out" ${llvm.llvm}/bin/llvm-readobj > "$out/images.json"
  ''
