"""Source snapshots and artifact receipts; compilers run only in Nix recipes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from .common import Failure, digest, git, run, write_json


def catalog():
    value = json.loads(Path(os.environ["WB_BUILD_TARGETS"]).read_text())
    if value.get("schemaVersion") != 1:
        raise Failure("unsupported build target schema", 2)
    return value


def target(name):
    value = catalog()["targets"].get(name)
    if value is None:
        raise Failure("unknown build target: " + name, 2)
    return value


def plan(ws, name, configuration="release", mode="release"):
    contract = target(name)
    if configuration not in contract["configurations"]:
        raise Failure("unsupported build configuration", 2)
    records = ws.status(contract["repositories"])
    result = {"schemaVersion": 1, "target": name, "configuration": configuration,
            "mode": mode, "contract": contract, "sources": records,
            "lockSha256": digest(ws.root / "devenv.lock"),
            "available": contract["backend"] == "nix",
            "externalStep": contract.get("reason") or
            ("Stage 4 devbox build backend is unavailable; no Windows execution was attempted"
             if contract["backend"] == "devbox" else None)}
    if contract["backend"] != "nix" and all(record["present"] for record in records):
        request = {"system": os.environ["WB_SYSTEM"], "target": name, "configuration": configuration,
                   "sources": {r["repository"]: {"path": r["path"]} for r in records}}
        expression = 'import (builtins.toPath (builtins.getEnv "WB_DISPATCH_EXPRESSION")) { nixpkgsPath = builtins.getEnv "WB_NIXPKGS"; request = builtins.getEnv "WB_DISPATCH_REQUEST"; }'
        result["dispatch"] = json.loads(run([os.environ["WB_NIX"], "eval", "--impure", "--json", "--expr", expression],
                                             env=dict(os.environ, WB_DISPATCH_REQUEST=json.dumps(request))).stdout)
    return result


def _export(path, destination, mode, expected=None, recursive=False):
    """Copy Git-owned contents only; never compile in or mutate the checkout."""
    head = git(path, "rev-parse", "HEAD").stdout.strip()
    if expected and mode == "release" and head != expected:
        raise Failure("release source differs from its declared pin", source=str(path), expected=expected, observed=head)
    diff = git(path, "diff", "--binary", "--ignore-submodules=all", "HEAD").stdout
    untracked = git(path, "ls-files", "--others", "--exclude-standard", "-z").stdout.split("\0")
    untracked = [name for name in untracked if name]
    conflicts = git(path, "ls-files", "-u").stdout
    if conflicts or (mode == "release" and (diff or untracked)):
        raise Failure("release build requires a clean source snapshot", source=str(path), mode=mode)
    destination.mkdir(parents=True, exist_ok=True)
    files = git(path, "ls-files", "--stage", "-z").stdout.split("\0")
    children = []
    for record in files:
        if not record:
            continue
        header, name = record.split("\t", 1)
        filemode, oid, stage = header.split()
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise Failure("invalid source path", 2)
        source, dest = path / relative, destination / relative
        if filemode == "160000":
            # Component shader/header modules are governed by their gitlinks.
            # Managed dependencies are separate snapshots, not recursively copied.
            if recursive:
                if not (source / ".git").exists():
                    raise Failure("required shader/header gitlink is uninitialized", source=str(source), revision=oid)
                children.append({"path": name, **_export(source, dest, mode, oid, recursive=True)})
            else:
                children.append({"path": name, "revision": oid, "materialized": False})
            continue
        if not source.exists() and not source.is_symlink():
            continue  # A tracked development deletion is part of diff identity.
        _copy_source(source, dest, destination)
        if mode == "release":
            content = os.readlink(dest).encode() if dest.is_symlink() else dest.read_bytes()
            blob = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
            if blob != oid:
                raise Failure("source changed while exporting a release snapshot", source=str(source))
    for name in untracked:
        _copy_source(path / name, destination / name, destination)
    final_diff = git(path, "diff", "--binary", "--ignore-submodules=all", "HEAD").stdout
    final_untracked = [name for name in git(path, "ls-files", "--others", "--exclude-standard", "-z").stdout.split("\0") if name]
    if git(path, "rev-parse", "HEAD").stdout.strip() != head or final_diff != diff or final_untracked != untracked:
        raise Failure("source changed during snapshot export; retry explicitly", source=str(path))
    for name in untracked:
        source, exported = path / name, destination / name
        if source.is_symlink() != exported.is_symlink() or (os.readlink(source) != os.readlink(exported) if source.is_symlink() else digest(source) != digest(exported)):
            raise Failure("untracked source changed during snapshot export", source=str(source))
    write_json(destination / ".wb-source.json", {"revision": head, "gitlinks": children})
    (destination / ".wb-revision").write_text(head[:8] + "\n")
    hashes = [{"path": str(p.relative_to(destination)), "sha256": digest(p)}
              for p in sorted(destination.rglob("*")) if p.is_file() and p.name != ".wb-source.json"]
    diff_identity = diff.encode() + json.dumps([f for f in hashes if f["path"] in untracked], sort_keys=True).encode()
    return {"revision": head, "diffSha256": hashlib.sha256(diff_identity).hexdigest() if diff or untracked else None,
            "snapshotSha256": hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
            "gitlinks": children, "untracked": untracked}


def _copy_source(source, destination, boundary):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        link = os.readlink(source)
        resolved = (destination.parent / link).resolve()
        if Path(link).is_absolute() or (resolved != boundary and boundary not in resolved.parents):
            raise Failure("source symlink escapes the exported snapshot", source=str(source))
        destination.symlink_to(link)
    else:
        shutil.copy2(source, destination)


def _files(root):
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() and not path.resolve().is_relative_to(root.resolve()) and not str(path.resolve()).startswith("/nix/store/"):
            raise Failure("artifact links must reference the export or immutable Nix closure", artifact=str(path))
        if path.is_file():
            record = {"path": str(path.relative_to(root)), "sha256": digest(path),
                      "size": path.stat().st_size}
            if path.is_symlink():
                record["linkTarget"] = os.readlink(path)
            files.append(record)
        elif path.is_symlink():
            if not path.is_dir():
                raise Failure("broken artifact symlink", artifact=str(path))
            files.append({"path": str(path.relative_to(root)), "type": "directorySymlink",
                          "linkTarget": os.readlink(path)})
    return files


def execute(ws, name, configuration, mode, operation_id):
    try:
        return _execute(ws, name, configuration, mode, operation_id)
    except (Failure, OSError, ValueError, KeyError) as exc:
        path = ws.state / "operations" / (operation_id + ".json")
        receipt = json.loads(path.read_text()) if path.exists() else {"kind": "build", "target": name}
        receipt.update(state="failed", error=str(exc), exitCode=exc.code if isinstance(exc, Failure) else 1)
        ws.journal(operation_id, receipt)
        raise


def _execute(ws, name, configuration, mode, operation_id):
    selection = plan(ws, name, configuration, mode)
    contract = selection["contract"]
    if not selection["available"]:
        raise Failure(selection["externalStep"], 3, plan=selection, backend=contract["backend"])
    if os.environ["WB_SYSTEM"] != "x86_64-linux":
        raise Failure("initial build acceptance requires an x86_64 Linux host", 3)
    directory = ws.state / "builds" / operation_id
    directory.mkdir(parents=True)
    # Lock the complete source closure while exporting. Builds use the snapshot
    # after this lock is released, so edits during a long build cannot affect it.
    source_records = {}
    with ws.repo_locks(contract["repositories"]):
        for component in contract["repositories"]:
            path = ws.validate_checkout(component)
            exported = directory / "sources" / component
            identity = _export(path, exported, mode, ws.repos[component]["pin"]["rev"],
                               recursive=component in {"dxvk", "vkd3d-proton"})
            source_records[component] = {"path": str(exported), "canonicalUrl": ws.repos[component]["url"],
                                         "declaredPin": ws.repos[component]["pin"]["rev"], **identity}
            source_records[component]["narHash"] = run([os.environ["WB_NIX"], "hash", "path", "--sri", exported]).stdout.strip()
    specification = {"schemaVersion": 1, "target": name, "configuration": configuration,
                     "system": os.environ["WB_SYSTEM"], "sources": source_records}
    spec_path = directory / "specification.json"
    write_json(spec_path, specification)
    receipt = {"kind": "build", "state": "building", "target": name, "specification": str(spec_path),
               "log": str(directory / "build.log"), "mode": mode, "configuration": configuration}
    ws.journal(operation_id, receipt)
    expression = os.environ["WB_BUILD_EXPRESSION"]
    argv = [os.environ["WB_NIX"], "build", "--json", "--out-link", str(directory / "result"), "--print-build-logs",
            "--file", expression, "--argstr", "nixpkgsPath", os.environ["WB_NIXPKGS"],
            "--argstr", "specification", str(spec_path)]
    with (directory / "build.log").open("w") as log:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=log, text=True)
        stdout, _ = proc.communicate()
    if proc.returncode:
        receipt.update(state="failed", exitCode=proc.returncode)
        ws.journal(operation_id, receipt)
        raise Failure("Nix component build failed; inspect the retained build log", proc.returncode,
                      receipt=str(ws.state / "operations" / (operation_id + ".json")), log=receipt["log"])
    built = json.loads(stdout)
    output = Path(built[0]["outputs"]["out"])
    # Output identity is immutable in the store. Export into a unique directory;
    # never replace a prior artifact or mix guest and native output roots.
    export = ws.out / ("guest" if contract["abi"].startswith("windows") else "native") / operation_id
    export.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(output, export / "files", symlinks=True)
    files = _files(export / "files")
    licenses = [f["path"] for f in files if "licenses/" in f["path"]]
    symbols = [f["path"] for f in files if "sha256" in f and ("/debug/" in f["path"] or f["path"].endswith(".pdb"))]
    if not licenses:
        raise Failure("artifact output lacks retained licenses", artifact=str(export))
    derivation = built[0]["drvPath"]
    provenance = json.loads(run([os.environ["WB_NIX"], "derivation", "show", "--recursive", derivation]).stdout)
    toolchains = sorted(provenance)
    write_json(directory / "derivations.json", provenance)
    manifest = {"schemaVersion": 1, "artifactId": operation_id, "target": name,
                "abi": contract["abi"], "configuration": configuration, "mode": mode,
                "sources": {key: {k: v for k, v in val.items() if k != "path"} for key, val in source_records.items()},
                "dependencies": {key: val["revision"] for key, val in source_records.items()},
                "toolchain": {"nixpkgs": os.environ["WB_NIXPKGS"], "lockSha256": selection["lockSha256"],
                              "derivations": toolchains},
                "recipe": {"expression": expression, "rootRevision": git(ws.root, "rev-parse", "HEAD").stdout.strip(),
                           "sharedOperationsNarHash": run([os.environ["WB_NIX"], "hash", "path", "--sri", Path(expression).parent]).stdout.strip(),
                           "controlPlaneStorePath": os.environ["WB_OPERATION_SOURCES"],
                           "rootDiffSha256": hashlib.sha256(git(ws.root, "diff", "--binary", "HEAD").stdout.encode()).hexdigest()},
                "outputs": built, "files": files, "licenses": licenses,
                "symbols": symbols, "embeddedSymbols": name == "dxvk-win64",
                "provenance": {"operationId": operation_id, "derivations": str(directory / "derivations.json")},
                "state": "built", "installed": False, "loaded": False}
    images = []
    for file in files:
        image = export / "files" / file["path"]
        if not image.is_file():
            continue
        with image.open("rb") as handle:
            magic = handle.read(4)
        if magic[:2] == b"MZ":
            headers = run([os.environ["WB_OBJDUMP"], "-p", image]).stdout
            sections = run([os.environ["WB_OBJDUMP"], "-h", image]).stdout
            images.append({"path": file["path"], "format": "PE", "headers": headers, "sections": sections,
                           "embeddedDebug": ".debug_info" in sections})
            if name == "dxvk-win64":
                lower = headers.lower()
                if "pei-x86-64" not in lower or any(lib in lower for lib in ["vcruntime", "msvcp", "libgcc_s", "libstdc++", "libwinpthread", "mcfgthread"]):
                    raise Failure("cross artifact architecture/CRT imports violate the target contract", artifact=str(image))
        elif magic == b"\x7fELF":
            images.append({"path": file["path"], "format": "ELF",
                           "headers": run([os.environ["WB_READELF"], "-h", "-n", "-d", image]).stdout})
    manifest["images"] = images
    manifest["closure"] = json.loads(run([os.environ["WB_NIX"], "path-info", "--recursive", "--json", output]).stdout)
    manifest_path = export / "manifest.json"
    write_json(manifest_path, manifest)
    for path in export.rglob("*"):
        if path.is_file() and not path.is_symlink():
            path.chmod(path.stat().st_mode & ~0o222)
    manifest_path.chmod(0o444)
    receipt.update(state="succeeded", exitCode=0, manifest=str(manifest_path),
                   manifestSha256=digest(manifest_path), outputs=built, artifactDirectory=str(export))
    ws.journal(operation_id, receipt)
    return receipt


def verify(path):
    path = Path(path).resolve()
    manifest = json.loads(path.read_text())
    if manifest.get("schemaVersion") != 1 or manifest.get("state") != "built":
        raise Failure("unsupported artifact manifest", 2)
    root = path.parent / "files"
    expected = manifest["files"]
    if not expected or _files(root) != expected:
        raise Failure("artifact hashes/file set differ from the manifest", manifest=str(path))
    return {"state": "verified", "manifest": str(path), "manifestSha256": digest(path),
            "artifactId": manifest["artifactId"], "filesVerified": len(expected),
            "installed": False, "loaded": False}
