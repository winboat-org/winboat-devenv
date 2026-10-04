"""Refuse compiler debug information before building and compiler PDBs after it."""
import json
from pathlib import Path
import re
import shlex
import sys

commands_path, compiler_source, compiler_build = map(Path, sys.argv[1:4])
commands = json.loads(commands_path.read_text())
for command in commands:
    if Path(command["file"]).suffix.lower() not in {".c", ".cc", ".cpp", ".cxx"}:
        continue
    arguments = command.get("arguments") or shlex.split(command["command"])
    assert not any(a.upper() in {"/MD", "/MDD", "-MD", "-MDD"} for a in arguments), f"Dynamic CRT: {command['file']}"
compiler_commands = [c for c in commands if Path(c["file"]).is_relative_to(compiler_source)]
assert compiler_commands, "No LLVM/Clang compile commands were recorded"
for command in compiler_commands:
    arguments = command.get("arguments") or shlex.split(command["command"])
    assert not any(re.fullmatch(r"[-/]Z[iI7]|-g(?!0).*", a) for a in arguments), command["file"]
pdbs = list(compiler_build.rglob("*.pdb"))
if "--preflight" not in sys.argv:
    assert not pdbs, f"LLVM/Clang generated compiler PDBs: {pdbs}"
    print(json.dumps({"schemaVersion": 1, "debugSymbols": False, "pdbFiles": 0,
        "compilerCommandsChecked": len(compiler_commands), "backend": "linux-msvc-cross"}))
