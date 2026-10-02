import contextlib
import copy
import json
import os
from pathlib import Path
import re

from .common import Failure, git, locked, parse_pins, valid_ref, valid_sha, write_json


def discover(explicit=None):
    if explicit:
        candidates = [Path(explicit).expanduser().resolve()]
    else:
        here = Path.cwd().resolve()
        candidates = [here, *here.parents]
        if os.environ.get("WB_WORKSPACE_ROOT"):
            candidates.append(Path(os.environ["WB_WORKSPACE_ROOT"]).resolve())
    for path in candidates:
        if (path / "nix/repositories.nix").is_file() and (path / "devenv.nix").is_file():
            return path
    raise Failure("workspace not found; pass --workspace <root>", 2)


def merge(base, override):
    result = copy.deepcopy(base)
    for key, value in override.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else value
    return result


class Workspace:
    def __init__(self, root, invocation=None):
        self.root = Path(root).resolve()
        self.config = json.loads((self.root / "config/defaults.json").read_text())
        local = self.root / "local.json"
        if local.exists():
            override = json.loads(local.read_text())
            if override.get("schemaVersion") != 1:
                raise Failure("local.json requires schemaVersion 1", 2)
            if set(override) - {"schemaVersion", "workspace", "devbox"}:
                raise Failure("unknown local configuration field", 2)
            self.config = merge(self.config, override)
        inherited = os.environ.get("WB_INVOCATION_PATHS")
        if inherited:
            self.config = merge(self.config, {"workspace": json.loads(inherited)})
        if invocation:
            self.config = merge(self.config, {"workspace": invocation})
        settings = self.config["workspace"]
        allowed = {"repositoriesRoot", "stateRoot", "outRoot", "repositoryOverrides", "remotes", "forkNamespace", "gitTransport"}
        if set(settings) - allowed:
            raise Failure("unknown workspace configuration field", 2)
        if settings["gitTransport"] not in {"https", "ssh"}:
            raise Failure("gitTransport must be https or ssh", 2)
        namespace = settings.get("forkNamespace")
        if namespace is not None and not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", namespace):
            raise Failure("invalid forkNamespace", 2)
        self.state = self.resolve(settings["stateRoot"])
        self.out = self.resolve(settings["outRoot"])
        self.repo_root = self.resolve(settings["repositoriesRoot"])
        for path in [self.state, self.out, self.repo_root]:
            if path == self.root or path in self.root.parents:
                raise Failure("output locations cannot contain the workspace", 2)
        if any(a == b or a in b.parents or b in a.parents for a, b in [(self.state, self.repo_root), (self.out, self.repo_root), (self.state, self.out)]):
            raise Failure("repository/state/output locations must be disjoint", 2)
        self.manifest = json.loads(Path(os.environ["WB_MANIFEST_FILE"]).read_text())
        if self.manifest.get("schemaVersion") != 1 or self.manifest.get("layoutVersion") != 1:
            raise Failure("unsupported repository layout/schema", 2)
        self.repos = copy.deepcopy(self.manifest["repositories"])
        self.pins_path = self.root / "nix/pins.nix"
        self.refresh()
        overrides = settings["repositoryOverrides"]
        if not isinstance(overrides, dict) or not isinstance(settings["remotes"], dict):
            raise Failure("repositoryOverrides/remotes must be objects", 2)
        if (set(overrides) | set(settings["remotes"])) - set(self.repos):
            raise Failure("unknown repository override", 2)
        self.paths = {}
        for name in self.order(self.repos):
            repo = self.repos[name]
            override = overrides.get(name)
            if override is not None:
                if not isinstance(override, dict) or set(override) - {"path", "adopt", "readOnly"} or not override.get("adopt"):
                    raise Failure("repositoryOverrides require explicit path/adopt: true", 2)
                path = self.resolve(override["path"])
                repo["readOnly"] = override.get("readOnly", False)
            else:
                path = (self.paths[repo["parent"]] / repo["submodulePath"] if repo["parent"]
                        else self.repo_root / Path(repo["path"]).relative_to("repos"))
            if repo["parent"] and self.repos[repo["parent"]].get("readOnly"):
                repo["readOnly"] = True
            if path == self.root or path in self.root.parents or self.state == path or self.state in path.parents:
                raise Failure("invalid repository location: " + name, 2)
            self.paths[name] = path.resolve()
            repo["fetchUrl"] = settings["remotes"].get(name, repo["pin"].get("sourceUrl") or repo["url"])
            if not isinstance(repo["fetchUrl"], str) or not repo["fetchUrl"] or repo["fetchUrl"].startswith("-") or "\n" in repo["fetchUrl"]:
                raise Failure("invalid repository URL", 2)
        if len(set(self.paths.values())) != len(self.paths):
            raise Failure("duplicate writable repository location", 2)
        for name, repo in self.repos.items():
            if repo["parent"] and self.paths[name] != self.paths[repo["parent"]] / repo["submodulePath"]:
                raise Failure("nested override must retain the declared parent layout: " + name, 2)

    def resolve(self, value):
        if not isinstance(value, str) or not value:
            raise Failure("path overrides must be nonempty strings", 2)
        path = Path(value).expanduser()
        return (path if path.is_absolute() else self.root / path).resolve()

    def refresh(self):
        pins = parse_pins(self.pins_path.read_text())["repositories"]
        if set(pins) != set(self.repos):
            raise Failure("pins and repository inventory differ", 2)
        for name, pin in pins.items():
            if pin["rev"] is not None and not valid_sha(pin["rev"]):
                raise Failure("invalid revision: " + name, 2)
            if pin["ref"] is not None and not valid_ref(pin["ref"]):
                raise Failure("invalid development ref: " + name, 2)
            self.repos[name]["pin"] = pin

    def select(self, args):
        requested = set()
        if getattr(args, "subset", None):
            if args.subset == "all":
                requested.update(self.repos)
            elif args.subset in self.manifest["subsets"]:
                requested.update(self.manifest["subsets"][args.subset])
            else:
                raise Failure("unknown subset: " + args.subset, 2)
        for name in getattr(args, "repo", []) or []:
            name = "clvk-helios" if name == "clkvk-helios" else name
            if name not in self.repos:
                raise Failure("unknown repository: " + name, 2)
            requested.add(name)
        if not requested:
            requested.update(self.repos)
        selected = set(requested)
        pending = list(selected)
        while pending:
            for dependency in self.repos[pending.pop()]["dependencies"]:
                if dependency not in selected:
                    selected.add(dependency)
                    pending.append(dependency)
        containers = set()
        for name in selected:
            parent = self.repos[name]["parent"]
            while parent:
                if parent not in selected:
                    containers.add(parent)
                parent = self.repos[parent]["parent"]
        return sorted(selected), sorted(containers)

    def order(self, names, children_first=False):
        names = set(names)
        if children_first:
            result, visiting, visited = [], set(), set()
            def visit(name):
                if name in visiting:
                    raise Failure("cyclic publication dependencies", 2)
                if name in visited:
                    return
                visiting.add(name)
                dependencies = set(self.repos[name]["dependencies"])
                dependencies.update(child for child, repo in self.repos.items() if repo["parent"] == name)
                for dependency in sorted(dependencies & names):
                    visit(dependency)
                visiting.remove(name)
                visited.add(name)
                result.append(name)
            for name in sorted(names):
                visit(name)
            return result
        def depth(name):
            parent = self.repos[name]["parent"]
            return 1 + depth(parent) if parent else 0
        return sorted(names, key=lambda name: (depth(name), name))

    def exists(self, name):
        path = self.paths[name]
        # rev-parse on an empty submodule directory would return the parent repo.
        if not (path / ".git").exists():
            return False
        proc = git(path, "rev-parse", "--show-toplevel", check=False)
        return proc.returncode == 0 and Path(proc.stdout.strip()).resolve() == path

    def validate_checkout(self, name, mutable=False):
        repo, path = self.repos[name], self.paths[name]
        if mutable and repo.get("readOnly"):
            raise Failure("read-only adopted reference: " + name)
        if not self.exists(name):
            raise Failure("checkout missing: " + name)
        if path.stat().st_uid != os.getuid():
            raise Failure("checkout is not owned by the current user: " + name)
        # Read stored identities; get-url/remote -v expand personal insteadOf
        # rules, which must not make a canonical checkout look foreign.
        remotes = git(path, "config", "--get-regexp", r"^remote\..*\.url$", check=False).stdout
        urls = {line.split(None, 1)[1] for line in remotes.splitlines()}
        allowed = {repo["url"], repo["fetchUrl"]}
        if not urls & allowed:
            raise Failure("checkout identity/remotes do not match: " + name)
        return path

    def status(self, names):
        records = []
        for name in names:
            record = {"repository": name, "path": str(self.paths[name]), "pin": self.repos[name]["pin"], "present": self.exists(name)}
            if record["present"]:
                record.update(head=git(self.paths[name], "rev-parse", "HEAD").stdout.strip(),
                              changes=git(self.paths[name], "status", "--porcelain=v1", "--untracked-files=all").stdout.splitlines(),
                              branch=git(self.paths[name], "symbolic-ref", "-q", "HEAD", check=False).stdout.strip() or None)
            records.append(record)
        return records

    @contextlib.contextmanager
    def repo_locks(self, names):
        with contextlib.ExitStack() as stack:
            for name in sorted(names):
                stack.enter_context(locked(self.state / "locks" / (name + ".lock")))
            yield

    def journal(self, operation_id, data):
        path = self.state / "operations" / (operation_id + ".json")
        write_json(path, {"schemaVersion": 1, "operationId": operation_id, **data})
        return path
