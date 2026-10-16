{ pkgs }:
let
  # Exact LLVM commit from the selected clspv's deps.json; NAR hash measured by
  # nix-prefetch-git. Guest builds never execute fetch_sources.py.
  llvm = pkgs.fetchgit {
    url = "https://github.com/llvm/llvm-project.git";
    rev = "140fc5aa2a0a754db87c68b2e3861c70dd94360b";
    hash = "sha256-Yk4B1lYOCCl8EUjJeTwQ6SIkKVNghpSOIpfAw5YWIvU=";
  };
  khronos = import ./khronos-inputs.nix { inherit pkgs; };

in
pkgs.runCommand "clvk-windows-compiler-inputs" { nativeBuildInputs = [ pkgs.rsync ]; } ''
  mkdir -p $out/llvm $out/share/licenses/llvm
  # Tests contain deliberate Windows device names and links. Clang enters its
  # examples CMake directory unconditionally even with example targets disabled;
  # retain those sources, excluding only the disabled test/docs/benchmark trees.
  for directory in llvm clang libclc libc cmake runtimes third-party; do
    rsync -r --chmod=Du+w,Fu+w --exclude=test --exclude=tests --exclude=unittests \
      --exclude=docs --exclude=benchmarks \
      ${llvm}/"$directory" $out/llvm/
  done
  cp ${llvm}/LICENSE.TXT $out/share/licenses/llvm/
  while IFS= read -r -d "" notice; do
    relative="''${notice#"$out/llvm/"}"
    destination="$out/share/licenses/llvm/sources/$relative"
    mkdir -p "$(dirname "$destination")"
    cp "$notice" "$destination"
  done < <(find "$out/llvm" -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) -print0)
  echo 140fc5aa2a0a754db87c68b2e3861c70dd94360b > $out/llvm-revision
  cp ${
    pkgs.writeText "clvk-source-revisions.json" (
      builtins.toJSON {
        llvm = llvm.rev;

      }
    )
  } $out/source-revisions.json
  cp -R ${khronos}/share/licenses/. $out/share/licenses/
  for name in Vulkan-Loader Vulkan-Headers OpenCL-ICD-Loader OpenCL-Headers; do
    ln -s ${khronos}/"$name" $out/"$name"
  done
''
