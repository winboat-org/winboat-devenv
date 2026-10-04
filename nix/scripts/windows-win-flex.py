"""Give WinFlexBison's fixed temporary names a private per-process directory."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="winboat-flex-") as directory:
    environment = dict(os.environ, TEMP=directory, TMP=directory, FLEX_TMP_DIR=directory)
    executable = Path(__file__).resolve().parent.parent / "bin" / "win_flex-native.exe"
    result = subprocess.run([str(executable), *sys.argv[1:]], env=environment)
    sys.exit(result.returncode)
