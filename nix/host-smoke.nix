{
  pkgs,
  qemu,
  renderer,
  protocol,
}:
pkgs.runCommand "winboat-host-build-validation" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p $out/share/build-validation
  python3 ${./scripts/host-smoke.py} ${qemu} ${renderer} ${protocol} $out/share/build-validation/host-smoke.json
''
