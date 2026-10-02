import hashlib
import os
from pathlib import Path
import re
import sys
import time

from .common import Failure, git, run, write_json


def clean(ws, name, ignore_children=False):
    if not ws.exists(name):
        path = ws.paths[name]
        if path.exists() and any(path.iterdir()):
            raise Failure("nonempty unmanaged checkout path: " + str(path))
        return
    path = ws.validate_checkout(name, mutable=True)
    args = ["status", "--porcelain=v1", "--untracked-files=all"]
    if ignore_children:
        args += ["--ignore-submodules=all"]
    changes = git(path, *args).stdout
    if changes:
        raise Failure("sync refuses dirty/staged/untracked/conflicted checkout: " + name,
                      changes=changes.splitlines(), remedy="checkpoint selected paths or resolve work explicitly")
    # Detached checkout is reproducible; moving a branch that contains local
    # commits is not. Refuse rather than silently abandon unpushed development.
    head = git(path, "rev-parse", "HEAD").stdout.strip()
    branch = git(path, "symbolic-ref", "-q", "HEAD", check=False)
    if branch.returncode == 0 and head != ws.repos[name]["pin"]["rev"]:
        raise Failure("development branch differs from pin: " + name,
                      remedy="publish/checkpoint it, or explicitly detach before sync")


def cache_object(ws, name, rev=None, url=None, refresh=False):
    repo = ws.repos[name]
    rev = rev or repo["pin"]["rev"]
    if not rev:
        raise Failure("unresolved source pin: " + name)
    url = url or repo["fetchUrl"]
    cache = ws.state / "source-cache" / (name + "-" + hashlib.sha256(url.encode()).hexdigest()[:16] + ".git")
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        run([os.environ["WB_REAL_GIT"], "init", "--bare", cache])
    exists = git(cache, "cat-file", "-e", rev + "^{commit}", check=False).returncode == 0
    if not exists or refresh:
        print("Fetching exact source object for " + name, file=sys.stderr)
        git(cache, "fetch", "--no-tags", "--depth=1", url, rev)
    actual = git(cache, "rev-parse", rev + "^{commit}").stdout.strip()
    if actual != rev:
        raise Failure("source object identity differs: " + name)
    return cache


def gitlink(path, rev, subpath):
    line = git(path, "ls-tree", rev, "--", subpath).stdout.strip()
    if not line or not line.startswith("160000 commit "):
        raise Failure("missing parent gitlink: " + subpath)
    return line.split()[2]


def module_names(path, rev):
    result = git(path, "show", rev + ":.gitmodules", check=False)
    if result.returncode:
        return {}
    # git config's parser handles quoted submodule names/paths without shell eval.
    result = run([os.environ["WB_REAL_GIT"], "config", "--file", "-", "--get-regexp", r"^submodule\..*\.path$"],
                 input=result.stdout, check=False)
    return {line.split(None, 1)[1]: line.split(None, 1)[0][10:-5] for line in result.stdout.splitlines()}


def plan(ws, selected, containers):
    records = []
    for name in ws.order(set(selected) | set(containers)):
        repo, path = ws.repos[name], ws.paths[name]
        present = ws.exists(name)
        head = git(path, "rev-parse", "HEAD").stdout.strip() if present else None
        change = not present or head != repo["pin"]["rev"]
        records.append({"repository": name, "containerOnly": name in containers,
                        "path": str(path), "revision": repo["pin"]["rev"],
                        "action": "clone" if not present else "checkout" if change else "retain",
                        "writes": ([str(path)] if change else []),
                        "submoduleConfigWrites": str(ws.paths[repo["parent"]] / ".git") if not present and repo["parent"] else None})
    return {"selected": selected, "containers": containers, "repositories": records,
            "stateWrites": [str(ws.state / "source-cache"), str(ws.state / "operations"), str(ws.state / "locks")],
            "submodules": {name: ws.repos[name]["submodules"]["paths"] for name in selected},
            "developmentBranch": "wb repo branch --repo <id> [--name <branch>]"}


def sync(ws, selected, containers, operation_id):
    scope = set(selected) | set(containers)
    result = plan(ws, selected, containers)
    with ws.repo_locks(scope):
        # Preflight every affected checkout before any checkout mutation. Parent
        # containers at their pin can have unrelated work: we only read them.
        for name in scope:
            target = ws.repos[name]["pin"]["rev"]
            if target is None:
                raise Failure("unresolved source pin: " + name)
            if name in containers and ws.exists(name):
                ws.validate_checkout(name)
                if git(ws.paths[name], "rev-parse", "HEAD").stdout.strip() == target:
                    continue
            clean(ws, name, ignore_children=True)
            if ws.exists(name):
                path = ws.paths[name]
                managed = {r["submodulePath"] for r in ws.repos.values() if r["parent"] == name}
                for subpath in ws.repos[name]["submodules"]["paths"]:
                    if subpath not in managed and (path / subpath / ".git").exists():
                        if git(path / subpath, "status", "--porcelain", "--untracked-files=all").stdout:
                            raise Failure("dirty selected third-party submodule: " + name + ":" + subpath)
                for module in ws.repos[name]["submodules"].get("nested", []):
                    nested = path / module["parent"] / module["path"]
                    if (nested / ".git").exists() and git(nested, "status", "--porcelain", "--untracked-files=all").stdout:
                        raise Failure("dirty selected nested shader submodule: " + str(nested))
                if git(path, "rev-parse", "HEAD").stdout.strip() != target:
                    # Changing a parent with any dirty unselected child would
                    # make checkout semantics depend on Git's recursion config.
                    if git(path, "status", "--porcelain", "--untracked-files=all").stdout:
                        raise Failure("parent checkout change would affect dirty submodule state: " + name)
        # Cached metadata is needed on a new workspace. Parent gitlinks are
        # validated before materializing any managed source tree.
        caches = {name: cache_object(ws, name) for name in ws.order(scope)}
        for name in scope:
            parent = ws.repos[name]["parent"]
            if parent and gitlink(caches[parent], ws.repos[parent]["pin"]["rev"], ws.repos[name]["submodulePath"]) != ws.repos[name]["pin"]["rev"]:
                raise Failure("pin disagrees with parent gitlink: " + name,
                              remedy="make an explicit coherent parent/pin update")
        receipt = {"kind": "sync", "state": "running", **result, "completed": []}
        ws.journal(operation_id, receipt)
        try:
            for name in ws.order(scope):
                repo, path = ws.repos[name], ws.paths[name]
                parent = repo["parent"]
                if not ws.exists(name):
                    path.mkdir(parents=True, exist_ok=True)
                    git(path, "init")
                    git(path, "remote", "add", "origin", repo["fetchUrl"])
                    git(path, "fetch", "--no-tags", caches[name], repo["pin"]["rev"])
                    git(path, "-c", "submodule.recurse=false", "checkout", "--detach", repo["pin"]["rev"])
                    if parent:
                        names = module_names(ws.paths[parent], "HEAD")
                        module = names.get(repo["submodulePath"])
                        if not module:
                            raise Failure("missing selected .gitmodules path: " + name)
                        git(ws.paths[parent], "config", "submodule." + module + ".url", repo["fetchUrl"])
                        git(ws.paths[parent], "submodule", "absorbgitdirs", "--", repo["submodulePath"])
                elif git(path, "rev-parse", "HEAD").stdout.strip() != repo["pin"]["rev"]:
                    git(path, "fetch", "--no-tags", caches[name], repo["pin"]["rev"])
                    git(path, "-c", "submodule.recurse=false", "checkout", "--detach", repo["pin"]["rev"])
                # Managed children are handled above; only the parent's explicit
                # third-party allowlist may be initialized. Never --recursive.
                if name in selected:
                    managed = {r["submodulePath"] for r in ws.repos.values() if r["parent"] == name}
                    third_party = [p for p in repo["submodules"]["paths"] if p not in managed]
                    names = module_names(path, "HEAD")
                    for subpath in third_party:
                        if subpath not in names:
                            raise Failure("declared submodule missing at pin: " + name + ":" + subpath)
                        subdir = path / subpath
                        if (subdir / ".git").exists() and git(subdir, "status", "--porcelain", "--untracked-files=all").stdout:
                            raise Failure("dirty selected third-party submodule: " + subpath)
                        git(path, "-c", "submodule.recurse=false", "submodule", "update", "--init", "--depth=1", "--", subpath)
                    for module in repo["submodules"].get("nested", []):
                        parent_path, subpath = path / module["parent"], module["path"]
                        if module["parent"] not in third_party or subpath not in module_names(parent_path, "HEAD"):
                            raise Failure("nested shader module is outside the selected gitlink contract", 2)
                        git(parent_path, "-c", "submodule.recurse=false", "submodule", "update", "--init", "--depth=1", "--", subpath)
                receipt["completed"].append(name)
                ws.journal(operation_id, receipt)
            receipt["state"] = "succeeded"
            ws.journal(operation_id, receipt)
        except Exception as exc:
            receipt.update(state="failed", error=str(exc))
            ws.journal(operation_id, receipt)
            raise
    return receipt


def branch(ws, selected, name=None):
    if len(selected) != 1:
        raise Failure("branch requires exactly one selected repository (without dependency closure)", 2)
    repo = selected[0]
    path = ws.validate_checkout(repo, mutable=True)
    name = name or ws.repos[repo]["pin"]["ref"]
    if not name:
        raise Failure("development ref unresolved; pass --name", 2)
    name = name.removeprefix("refs/heads/")
    git(path, "check-ref-format", "--branch", name)
    git(path, "switch", "-c", name)
    return {"repository": repo, "branch": name}


def fork(ws, selected, namespace, operation_id, apply=False):
    namespace = namespace or ws.config["workspace"]["forkNamespace"]
    if not isinstance(namespace, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", namespace):
        raise Failure("fork requires a valid GitHub namespace", 2)
    remotes = []
    with ws.repo_locks(selected) if apply else __import__("contextlib").nullcontext():
        for name in selected:
            path = ws.validate_checkout(name, mutable=apply)
            repo = ws.repos[name]
            if git(path, "cat-file", "-e", repo["pin"]["rev"] + "^{commit}", check=False).returncode:
                raise Failure("pinned object unavailable locally before fork: " + name,
                              remedy="sync the exact pin from upstream before changing remotes")
            url = ("https://github.com/" + namespace + "/" + name + ".git" if ws.config["workspace"]["gitTransport"] == "https"
                   else "git@github.com:" + namespace + "/" + name + ".git")
            # Local remotes explicitly configured for integration fixtures or
            # alternate transports are still local policy, never shared pins.
            template = ws.config["workspace"]["remotes"].get(name)
            if template and "{namespace}" in template:
                url = template.format(namespace=namespace)
            probe = run([os.environ["WB_REAL_GIT"], "ls-remote", url], check=False)
            if probe.returncode:
                raise Failure("fork unavailable: " + name, creation="gh repo fork winboat-org/" + name + " --clone=false", diagnostic=probe.stderr.strip())
            upstream = git(path, "config", "--get", "remote.upstream.url", check=False)
            canonical = repo["url"]
            if upstream.returncode == 0 and upstream.stdout.strip() != canonical:
                raise Failure("upstream remote conflicts with canonical identity: " + name)
            origins = git(path, "config", "--get-all", "remote.origin.url").stdout.splitlines()
            pushurls = git(path, "config", "--get-all", "remote.origin.pushurl", check=False).stdout.splitlines()
            if len(origins) != 1 or pushurls:
                raise Failure("fork refuses multiple origin URLs/pushurl overrides: " + name)
            remotes.append({"repository": name, "oldOrigin": origins[0], "origin": url, "upstream": canonical})
        receipt = {"kind": "fork", "namespace": namespace, "state": "planned", "remotes": remotes, "completed": []}
        if apply:
            ws.journal(operation_id, receipt)
            try:
                for change in remotes:
                    name = change["repository"]
                    path = ws.paths[name]
                    if git(path, "remote", "get-url", "upstream", check=False).returncode:
                        git(path, "remote", "add", "upstream", change["upstream"])
                    git(path, "remote", "set-url", "origin", change["origin"])
                    parent = ws.repos[name]["parent"]
                    if parent and ws.exists(parent):
                        names = module_names(ws.paths[parent], "HEAD")
                        module = names.get(ws.repos[name]["submodulePath"])
                        if module:
                            git(ws.paths[parent], "config", "submodule." + module + ".url", change["origin"])
                    receipt["completed"].append(name)
                    ws.journal(operation_id, receipt)
                receipt["state"] = "succeeded"
                ws.journal(operation_id, receipt)
            except Exception as exc:
                receipt.update(state="partial", error=str(exc))
                ws.journal(operation_id, receipt)
                raise Failure("fork partially applied; inspect receipt", receiptId=operation_id) from exc
    return receipt


def verify(ws, selected):
    records = []
    for name in selected:
        repo = ws.repos[name]
        ref, rev = repo["pin"]["ref"], repo["pin"]["rev"]
        url = repo["pin"].get("sourceUrl") or repo["url"]
        print("Verifying source/ref for " + name, file=sys.stderr)
        advertised = run([os.environ["WB_REAL_GIT"], "ls-remote", "--symref", url, "HEAD", "refs/heads/*"]).stdout
        cache = cache_object(ws, name, url=url, refresh=True)
        parent = repo["parent"]
        if parent:
            parent_cache = cache_object(ws, parent, url=ws.repos[parent]["url"])
            if gitlink(parent_cache, ws.repos[parent]["pin"]["rev"], repo["submodulePath"]) != rev:
                raise Failure("remote pin/gitlink mismatch: " + name)
        if ref and not any(line.endswith("\t" + ref) for line in advertised.splitlines()):
            raise Failure("development ref unavailable: " + name)
        records.append({"repository": name, "canonicalUrl": repo["url"], "sourceUrl": url, "revision": rev,
                        "developmentRef": ref, "objectVerified": True, "advertisedRefs": advertised.splitlines(),
                        "timestamp": time.time(), "cache": str(cache)})
    evidence = ws.state / "verification" / "sources.json"
    write_json(evidence, {"schemaVersion": 1, "repositories": records})
    return {"repositories": records, "evidence": str(evidence)}
