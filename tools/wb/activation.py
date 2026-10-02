import json
import os
from pathlib import Path

from .common import Failure, atomic_write, run, write_json


HOOKS = {"bash": 'if ! declare -F _devenv_hook >/dev/null; then\n  eval "$(devenv hook bash)"\nfi',
         "zsh": 'if (( ! $+functions[_devenv_hook] )); then\n  eval "$(devenv hook zsh)"\nfi',
         "fish": 'if not functions -q _devenv_hook\n    devenv hook fish | source\nend'}


def shell_path(shell):
    user = Path.home()
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(user / ".config")))
    return {"bash": user / ".bashrc", "zsh": Path(os.environ.get("ZDOTDIR", str(user))) / ".zshrc",
            "fish": config / "fish/config.fish", "nu": config / "nushell/autoload/devenv-hook.nu"}[shell]


def doctor(ws, shell=None, config=None):
    shells = [shell] if shell else ["bash", "zsh", "fish", "nu"]
    records = []
    for item in shells:
        path = ws.resolve(config) if config else shell_path(item)
        text = path.read_text() if path.is_file() else ""
        installed = "devenv hook " + item in text or (item == "nu" and "hook-should-activate" in text)
        records.append({"shell": item, "config": str(path), "hookConfigured": installed,
                        "remedy": None if installed else "wb setup --activation " + item + " --shell-config " + str(path)})
    # The native trust probe reads the CLI's actual trust database, including
    # relocation/revoke. A parent shell's DEVENV_ROOT must not suppress it.
    probe = run([os.environ["WB_DEVENV"], "hook-should-activate"], cwd=ws.root, check=False,
                env={k: v for k, v in os.environ.items() if k not in {"DEVENV_ROOT", "_DEVENV_HOOK_DIR"}})
    return {"hooks": records, "activeRoot": os.environ.get("DEVENV_ROOT"), "trusted": probe.returncode == 0 and probe.stdout.strip() == str(ws.root),
            "trustDiagnostic": probe.stderr.strip(),
            "trustRemedy": "run wb setup --activation <shell> to allow this checkout", "direnv": str(ws.root / ".envrc")}


def setup(ws, shell, config=None):
    if shell not in {"bash", "zsh", "fish", "nu"}:
        raise Failure("unsupported activation shell", 2)
    path = ws.resolve(config) if config else shell_path(shell)
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.read_text() if path.exists() else ""
    if shell == "nu":
        hook = run([os.environ["WB_DEVENV"], "hook", "nu"]).stdout
        if old and old != hook:
            raise Failure("existing Nushell autoload hook differs; choose another --shell-config path", 2)
        updated = hook
    else:
        hook = HOOKS[shell]
        # Detect already configured native hooks, including hooks with flags.
        updated = old if "devenv hook " + shell in old else old + ("\n" if old and not old.endswith("\n") else "") + "\n# WinBoat native devenv activation\n" + hook + "\n"
    if updated != old:
        atomic_write(path, updated, mode=0o644)
    run([os.environ["WB_DEVENV"], "allow"], cwd=ws.root)
    receipt = {"shell": shell, "config": str(path), "changed": updated != old, "allowedRoot": str(ws.root)}
    write_json(ws.state / "activation.json", receipt)
    return receipt
