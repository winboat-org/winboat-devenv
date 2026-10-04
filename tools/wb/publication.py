import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

from .common import Failure, atomic_write, edit_pins, git, identity, locked, parse_pins, run, valid_ref, valid_sha
from .repos import gitlink


def scoped_commit(path, entries, message, staged_entries=None, expected_blobs=None):
    """Commit only explicit blobs/gitlinks with a temporary index and HEAD CAS.

    The normal index keeps all other staged entries. For pins, staged_entries
    merges only our fields into the user's original staged blob.
    """
    head = git(path, "rev-parse", "HEAD").stdout.strip()
    index_path = Path(git(path, "rev-parse", "--path-format=absolute", "--git-path", "index").stdout.strip())
    index_lock = Path(str(index_path) + ".lock")
    try:
        fd = os.open(index_lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise Failure("Git index is locked; retry the checkpoint after the other Git operation finishes") from exc
    os.close(fd)
    try:
      with tempfile.TemporaryDirectory() as directory:
        for relative, expected_blob in (expected_blobs or {}).items():
            if git(path, "show", ":" + relative).stdout != expected_blob:
                raise Failure("staged pin data changed while planning; reconcile the receipt")
        # Prepare the merged normal index behind Git's own index.lock. Other
        # Git writers cannot interleave their staging with our checkpoint.
        shutil.copyfile(index_path, index_lock)
        merged_env = dict(os.environ, GIT_INDEX_FILE=str(index_lock))
        for relative, (mode, oid) in (staged_entries or entries).items():
            if mode is None:
                git(path, "update-index", "--force-remove", "--", relative, env=merged_env)
            else:
                git(path, "update-index", "--add", "--cacheinfo", mode, oid, relative, env=merged_env)
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(directory) / "index"))
        git(path, "read-tree", head, env=env)
        for relative, (mode, oid) in entries.items():
            if mode is None:
                git(path, "update-index", "--force-remove", "--", relative, env=env)
            else:
                git(path, "update-index", "--add", "--cacheinfo", mode, oid, relative, env=env)
        tree = git(path, "write-tree", env=env).stdout.strip()
        oldtree = git(path, "rev-parse", head + "^{tree}").stdout.strip()
        newhead = head
        if tree != oldtree:
            newhead = git(path, "commit-tree", tree, "-p", head, input=message + "\n").stdout.strip()
            git(path, "update-ref", "HEAD", newhead, head)
        os.replace(index_lock, index_path)
        return newhead
    finally:
        if index_lock.exists():
            index_lock.unlink()


def pin_transaction(ws, updates, expected, operation_id, defer=False):
    with locked(ws.state / "locks" / "pins.lock"):
        working = ws.pins_path.read_text()
        current = parse_pins(working)["repositories"]
        for name, fields in updates.items():
            old = expected[name]
            # A replay is idempotent. Disjoint concurrent updates merge; a
            # competing revision for the same repository requires a new plan.
            if current[name]["rev"] not in {old, fields.get("rev", old)}:
                raise Failure("pin compare-and-swap conflict: " + name)
        rendered = edit_pins(working, updates)
        if os.environ.get("WB_TEST_FAIL_PIN_WRITE") == "1":
            raise Failure("injected pin-write failure")
        atomic_write(ws.pins_path, rendered)
        if defer:
            return {"deferred": True, "rootCommit": None}
        # HEAD and index variants are edited separately. Unrelated working or
        # staged edits to *the same pins file* never leak into our checkpoint.
        head = git(ws.root, "show", "HEAD:nix/pins.nix").stdout
        index = git(ws.root, "show", ":nix/pins.nix").stdout
        committed_text = edit_pins(head, updates)
        staged_text = edit_pins(index, updates)
        committed_oid = git(ws.root, "hash-object", "-w", "--stdin", input=committed_text).stdout.strip()
        staged_oid = git(ws.root, "hash-object", "-w", "--stdin", input=staged_text).stdout.strip()
        if os.environ.get("WB_TEST_FAIL_PIN_COMMIT") == "1":
            raise Failure("injected pin-commit failure")
        kind = "publication" if all(fields.get("provenance") == "verified-push" for fields in updates.values()) else "source pin"
        commit = scoped_commit(ws.root, {"nix/pins.nix": ("100644", committed_oid)},
                               "chore(pins): record verified " + kind + " " + operation_id,
                               {"nix/pins.nix": ("100644", staged_oid)}, {"nix/pins.nix": index})
        return {"deferred": False, "rootCommit": commit}


def update_parent(ws, name, revision):
    parent = ws.repos[name]["parent"]
    if not parent:
        return []
    path = ws.validate_checkout(parent, mutable=True)
    relative = ws.repos[name]["submodulePath"]
    old = gitlink(path, "HEAD", relative)
    staged = git(path, "ls-files", "--stage", "--", relative).stdout.split()
    if not staged or staged[1] not in {old, revision} or staged[2] != "0":
        raise Failure("parent gitlink has unrelated staged/conflicted work: " + parent)
    commit = scoped_commit(path, {relative: ("160000", revision)}, "chore(deps): record " + name + " " + revision)
    return [{"repository": parent, "commit": commit, "gitlink": relative, "child": name, "state": "needs-publication"}]


def finish_push(ws, receipt):
    name, revision = receipt["repository"], receipt["pushedRevision"]
    pending = update_parent(ws, name, revision)
    receipt["pendingParents"] = pending
    ws.journal(receipt["operationId"], receipt)
    result = pin_transaction(ws, {name: {"rev": revision, "provenance": "verified-push"}},
                             {name: receipt["expectedOldPin"]}, receipt["operationId"], receipt.get("deferCheckpoint", False))
    receipt.update(result, state="deferred" if result["deferred"] else "succeeded")
    ws.journal(receipt["operationId"], receipt)
    # Retain dependency receipts and mark exactly which gitlink was published.
    # A newer parent commit is acceptable only when its tree contains that child.
    for path in (ws.state / "operations").glob("*.json"):
        previous = json.loads(path.read_text())
        changed = False
        for parent in previous.get("pendingParents", []):
            if parent["repository"] == name and parent["state"] == "needs-publication":
                child = parent["child"]
                expected = previous.get("pushedRevision")
                if expected and gitlink(ws.paths[name], revision, parent["gitlink"]) == expected:
                    parent.update(state="published", publishedCommit=revision, publicationOperation=receipt["operationId"])
                    changed = True
        if changed:
            ws.journal(previous["operationId"], previous)
    return receipt


def remote_revision(url, ref):
    result = run([os.environ["WB_REAL_GIT"], "ls-remote", "--refs", url, ref])
    lines = [line.split() for line in result.stdout.splitlines() if line.endswith("\t" + ref)]
    if len(lines) != 1 or not valid_sha(lines[0][0]):
        raise Failure("remote development ref cannot be verified", remote=url, ref=ref)
    return lines[0][0]


def push(ws, name, global_args, push_args, operation_id, defer=False):
    path = ws.validate_checkout(name, mutable=True)
    prefix = [os.environ["WB_REAL_GIT"], *global_args] if global_args else [os.environ["WB_REAL_GIT"], "-C", str(path)]
    # Pass through operations that cannot advance a managed branch pin.
    if any(a in {"--dry-run", "-n"} for a in push_args):
        result = run([*prefix, "push", *push_args], check=False)
        return {"state": "dry-run", "exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    if any(a in {"--all", "--mirror", "--prune"} or a.startswith("--repo=") for a in push_args):
        raise Failure("ambiguous managed push; use wb repo push --repo " + name + " --remote <remote> --source <ref>", 2)
    target = ws.repos[name]["pin"]["ref"]
    if not target:
        raise Failure("development ref unresolved; configure it with wb repo pin", 2)
    preflight = run([*prefix, "push", "--porcelain", "--dry-run", *push_args], check=False)
    effects, destinations = [], []
    for line in preflight.stdout.splitlines():
        if line.startswith("To "):
            destinations.append(line[3:])
        columns = line.split("\t")
        if len(columns) == 3 and ":" in columns[1]:
            source, destination = columns[1].split(":", 1)
            if destination == target and source and columns[0] != "-":
                effects.append((source, destination))
    if not effects:
        real = run([*prefix, "push", *push_args], check=False)
        return {"state": "push-failed" if real.returncode else "unselected-push", "exitCode": real.returncode, "stdout": real.stdout, "stderr": real.stderr}
    if len(effects) != 1 or len(destinations) != 1:
        raise Failure("multiple managed push destinations are ambiguous; use wb repo push with one remote", 2)
    source, target = effects[0]
    candidate = run([*prefix, "rev-parse", source + "^{commit}"]).stdout.strip()
    if not valid_sha(candidate):
        raise Failure("push source is not an exact commit", 2)
    for child, repo in ws.repos.items():
        if repo["parent"] == name and gitlink(path, candidate, repo["submodulePath"]) != repo["pin"]["rev"]:
            raise Failure("parent push disagrees with a managed child pin: " + child,
                          remedy="publish the child first, then checkpoint/push the matching parent gitlink")
    # Pins remain reproducible: a fork is only a remote override until its source
    # URL is explicitly selected for shared pins. Fixtures use local overrides.
    source_url = ws.repos[name]["pin"].get("sourceUrl") or ws.repos[name]["fetchUrl"]
    expanded = git(path, "ls-remote", "--get-url", source_url).stdout.strip()
    if destinations[0] != expanded:
        raise Failure("push destination differs from the pinned source URL; explicitly select the fork with wb repo pin --source-url", 2,
                      destination=destinations[0], sourceUrl=source_url)
    receipt = {"schemaVersion": 1, "operationId": operation_id, "kind": "push", "state": "prepared",
               "repository": name, "remote": destinations[0], "ref": target,
               "pushedRevision": candidate, "expectedOldPin": ws.repos[name]["pin"]["rev"],
               "deferCheckpoint": defer, "pendingParents": [], "gitArguments": [*global_args, "push", *push_args]}
    ws.journal(operation_id, receipt)
    real = run([*prefix, "push", *push_args], check=False)
    receipt.update(gitExitCode=real.returncode, stdout=real.stdout, stderr=real.stderr)
    if real.returncode:
        receipt["state"] = "push-failed"
        ws.journal(operation_id, receipt)
        return {**receipt, "exitCode": real.returncode}
    receipt["state"] = "remote-pushed"
    ws.journal(operation_id, receipt)
    try:
        verified = remote_revision(receipt["remote"], target)
        if verified != candidate:
            raise Failure("remote moved after push; refusing to guess pin", expected=candidate, observed=verified)
        receipt["remoteVerified"] = True
        ws.journal(operation_id, receipt)
        return finish_push(ws, receipt)
    except Exception as exc:
        receipt.update(state="partial", error=str(exc))
        ws.journal(operation_id, receipt)
        raise Failure("remote push succeeded; local checkpoint is incomplete. Run wb repo reconcile --operation " + operation_id,
                      receiptId=operation_id, remotePushed=True) from exc


def reconcile(ws, operation_id):
    if not operation_id.startswith("op-") or any(c not in "0123456789abcdef" for c in operation_id[3:]):
        raise Failure("invalid operation ID", 2)
    path = ws.state / "operations" / (operation_id + ".json")
    receipt = json.loads(path.read_text())
    if receipt.get("schemaVersion") != 1 or receipt.get("kind") != "push":
        raise Failure("receipt is not a supported push transaction", 2)
    name = receipt["repository"]
    with ws.repo_locks([name] + ([ws.repos[name]["parent"]] if ws.repos[name]["parent"] else [])):
        if remote_revision(receipt["remote"], receipt["ref"]) != receipt["pushedRevision"]:
            raise Failure("remote no longer contains the receipt's pushed revision")
        receipt["deferCheckpoint"] = False
        receipt["remoteVerified"] = True
        return finish_push(ws, receipt)


def checkpoint(ws, selected, paths, message, operation_id):
    if not paths:
        raise Failure("checkpoint requires explicit --path <repo-relative-path> (repeatable)", 2)
    commits = []
    with ws.repo_locks(set(selected) | {ws.repos[n]["parent"] for n in selected if ws.repos[n]["parent"]}):
        prepared = {}
        for name in ws.order(selected, children_first=True):
            path = ws.validate_checkout(name, mutable=True)
            entries = {}
            for requested in paths:
                if ":" in requested:
                    owner, relative = requested.split(":", 1)
                    if owner not in selected:
                        raise Failure("checkpoint path owner is outside selection: " + owner, 2)
                    if owner != name:
                        continue
                else:
                    relative = requested
                target = (path / relative).resolve()
                if not relative or Path(relative).is_absolute() or not target.is_relative_to(path) or relative == "." or ".git" in Path(relative).parts:
                    raise Failure("checkpoint path must be explicit and within the repository", 2)
                if target.is_dir():
                    raise Failure("checkpoint requires file paths, not blanket directories", 2)
                if not target.is_file():
                    if git(path, "ls-files", "--error-unmatch", "--", relative, check=False).returncode == 0:
                        entries[relative] = (None, None)
                        continue
                    raise Failure("checkpoint path missing: " + relative, 2)
                if git(path, "ls-files", "--unmerged", "--", relative).stdout:
                    raise Failure("checkpoint refuses unresolved conflicts: " + relative)
                oid = git(path, "hash-object", "-w", "--", relative).stdout.strip()
                mode = "100755" if os.access(target, os.X_OK) else "100644"
                entries[relative] = (mode, oid)
            prepared[name] = entries
        # All path scopes are validated before the first source commit. Retain
        # completed commits even if a later parent/index checkpoint fails.
        receipt = {"kind": "checkpoint", "state": "running", "commits": commits,
                   "externalStep": "publish child commits before parents with wb repo push; source pins advance only after remote verification"}
        ws.journal(operation_id, receipt)
        try:
            for name in ws.order(selected, children_first=True):
                path = ws.paths[name]
                entries = prepared[name]
                if not entries:
                    continue
                head = scoped_commit(path, entries, message)
                record = {"repository": name, "commit": head, "pendingParents": []}
                commits.append(record)
                ws.journal(operation_id, receipt)
                record["pendingParents"] = update_parent(ws, name, head)
                ws.journal(operation_id, receipt)
            receipt["state"] = "succeeded"
            ws.journal(operation_id, receipt)
        except Exception as exc:
            receipt.update(state="partial", error=str(exc))
            ws.journal(operation_id, receipt)
            raise Failure("checkpoint incomplete; completed commits are retained in receipt " + operation_id,
                          receiptId=operation_id, commits=commits) from exc
    return receipt


def split_git_args(argv):
    values = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
    index = 0
    while index < len(argv):
        value = argv[index]
        if value in values:
            index += 2
        elif value.startswith("-"):
            index += 1
        else:
            return argv[:index], value, argv[index + 1:]
    return argv, None, []


def git_wrapper(argv):
    global_args, command, args = split_git_args(argv)
    real = os.environ["WB_REAL_GIT"]
    if command != "push":
        os.execv(real, [real, *argv])
    probe = run([real, *global_args, "rev-parse", "--show-toplevel"], check=False)
    if probe.returncode:
        os.execv(real, [real, *argv])
    from .workspace import Workspace, discover
    try:
        ws = Workspace(discover())
    except Failure:
        os.execv(real, [real, *argv])
    path = Path(probe.stdout.strip()).resolve()
    matches = [name for name in ws.repos if path == ws.paths[name]]
    if len(matches) != 1:
        os.execv(real, [real, *argv])
    name = matches[0]
    try:
        parents = [ws.repos[name]["parent"]] if ws.repos[name]["parent"] else []
        with ws.repo_locks([name, *parents]):
            result = push(ws, name, global_args, args, identity())
        sys.stdout.write(result.get("stdout", ""))
        sys.stderr.write(result.get("stderr", ""))
        return result.get("exitCode", 0)
    except Failure as exc:
        print("wb git: " + str(exc), file=sys.stderr)
        return exc.code
