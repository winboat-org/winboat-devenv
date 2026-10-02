"""Software-only QEMU module/frontend acceptance; no guest installation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

qemu, renderer, protocol, output = map(Path, sys.argv[1:])
binary = qemu / "bin/qemu-system-x86_64"
modules = sorted((qemu / "lib/qemu").glob("*.so"))
assert modules, "QEMU modular build produced no modules"
env = {**os.environ, "QEMU_MODULE_DIR": str(qemu / "lib/qemu"), "SDL_VIDEODRIVER": "dummy"}
display = subprocess.run([binary, "-display", "help"], env=env, capture_output=True, text=True, check=True)
assert "sdl" in display.stdout and "egl-headless" in display.stdout, display.stdout
loader = subprocess.run([binary, "-device", "virtio-vga-gl,help"],
                        env={**env, "LD_DEBUG": "libs"}, capture_output=True, text=True, check=True)
assert str(renderer) in loader.stderr, "virtio GL module did not load the paired renderer"
assert "Only modules from the same build" not in loader.stderr

proc = subprocess.Popen([binary, "-machine", "q35,accel=tcg", "-nodefaults", "-display", "sdl",
                         "-S", "-qmp", "stdio", "-L", str(qemu / "share/qemu")],
                        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    greeting = json.loads(proc.stdout.readline())
    assert "QMP" in greeting
    proc.stdin.write('{"execute":"qmp_capabilities"}\n')
    proc.stdin.flush()
    response = json.loads(proc.stdout.readline())
    assert "return" in response, response
    mappings = Path(f"/proc/{proc.pid}/maps").read_text()
    assert str(qemu / "lib/qemu") in mappings, "SDL module was not mapped from this output"
    proc.stdin.write('{"execute":"quit"}\n')
    proc.stdin.flush()
    stdout, stderr = proc.communicate(timeout=30)
    assert proc.returncode == 0, stderr
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()

headers = sorted((protocol / "include/venus-protocol").glob("*.h"))
assert any("driver" in p.name for p in headers) and any("renderer" in p.name for p in headers)
report = {"schemaVersion": 1, "qemu": str(qemu), "renderer": str(renderer), "protocol": str(protocol),
          "displayHelp": display.stdout, "sdlSession": "dummy-driver-qmp-quit",
          "mappedModules": sorted({line.split()[-1] for line in mappings.splitlines() if str(qemu) in line}),
          "rendererLoaderTrace": [line.strip() for line in loader.stderr.splitlines() if str(renderer) in line],
          "modules": [{"path": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in modules],
          "headers": [{"path": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in headers],
          "gpuRendering": "pending-interactive-hardware-verification", "guestInstalled": False}
output.write_text(json.dumps(report, indent=2) + "\n")
