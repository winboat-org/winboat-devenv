"""Represent the locked Windows SDK on a case-sensitive build filesystem."""
import json
from pathlib import Path
import sys


def directory(path):
    entries = []
    names = set()
    for child in sorted(path.iterdir()):
        folded = child.name.casefold()
        if folded in names:
            raise ValueError(f"Windows header case collision: {child}")
        names.add(folded)
        if child.is_dir():
            entries.append(directory(child))
        else:
            entries.append({"type": "file", "name": child.name,
                            "external-contents": str(child)})
    return {"type": "directory", "name": path.name, "contents": entries}


root = Path(sys.argv[1])
roots = []
for include in [root / "crt/include", root / "sdk/include"]:
    entry = directory(include)
    entry["name"] = str(include)
    roots.append(entry)
(root / "headers-overlay.json").write_text(json.dumps({
    "version": 0, "case-sensitive": False, "use-external-names": False,
    "roots": roots,
}, sort_keys=True) + "\n")

# lld searches explicit library names on the real filesystem. Retain each
# publisher filename and add an alias for its case-insensitive Windows spelling.
for library_root in [root / "crt/lib", root / "sdk/lib"]:
    for file in sorted(library_root.rglob("*")):
        if file.is_file() and file.name != file.name.lower():
            alias = file.with_name(file.name.lower())
            if alias.exists():
                raise ValueError(f"Windows library case collision: {file}")
            alias.symlink_to(file.name)
