"""Inspect real MSVC PE images and refuse architecture or CRT contract failures."""
import json
from pathlib import Path
import re
import subprocess
import sys

root, readobj = Path(sys.argv[1]), sys.argv[2]
requested = next((arg.split("=", 1)[1] for arg in sys.argv[3:] if arg.startswith("--architecture=")), None)
assert requested in {None, "x64", "x86"}
images = []
for image in sorted(root.rglob("*")):
    if not image.is_file() or image.suffix.lower() not in {".dll", ".exe", ".a", ".lib"}:
        continue
    relative = image.relative_to(root)
    output = subprocess.check_output([readobj, "--file-headers", "--coff-imports", "--coff-directives", "--sections", str(image)], text=True)
    architecture = requested or ("x86" if "x86" in relative.parts else "x64")
    machine = "IMAGE_FILE_MACHINE_I386" if architecture == "x86" else "IMAGE_FILE_MACHINE_AMD64"
    machines = set(re.findall(r"Machine: (IMAGE_FILE_MACHINE_[A-Z0-9]+)", output))
    assert machines == {machine}, f"Architecture mismatch: {relative}: {machines}"
    assert not re.search(r"Name: (msvcrt|msvcp\d+|vcruntime\d+|ucrtbase|api-ms-win-crt-)", output, re.I), relative
    assert not re.search(r"[-/]DEFAULTLIB:[\"']?(MSVCRT[D]?|MSVCPRT[D]?)\b", output, re.I), relative
    images.append({"path": str(relative), "architecture": architecture, "machine": machine,
        "format": "COFF archive" if image.suffix.lower() in {".a", ".lib"} else "PE",
        "embeddedCodeView": ".debug$S" in output, "staticCrtVerified": True, "inspection": output})
assert images, "No cross-compiled images were inspected"
print(json.dumps(images, indent=2))
