"""Authenticated Windows transport and durable jobs shared by CLI and MCP."""
import base64
import json
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import time
import zipfile

from . import devbox
from .common import Failure, digest, git, identity, run, write_json

ROOT = r"C:\ProgramData\WinBoatDev"
PURPOSES = {"build", "install", "desktop", "system"}


def literal(value):
    if "\0" in str(value):
        raise Failure("NUL in PowerShell argument", 2)
    return "'" + str(value).replace("'", "''") + "'"


def encoded(script):
    return "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + base64.b64encode(script.encode("utf-16le")).decode()


def connection(ws, name):
    directory, record = devbox.load(ws, name)
    if not (directory / "known_hosts").is_file():
        raise Failure("guest SSH host key is not pinned", 3)
    return directory, record


def invoke(ws, name, script, check=True):
    directory, record = connection(ws, name)
    try:
        proc = subprocess.run([str(v) for v in devbox.ssh_command(directory, record)] + [encoded(script)],
                              text=True, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise Failure("Windows transport timed out; observe the durable task before retrying", 75)
    if check and proc.returncode:
        raise Failure(proc.stderr.strip() or proc.stdout.strip() or "Windows transport failed", proc.returncode)
    return proc


def remote_file(ws, name, path):
    output = invoke(ws, name, "$ErrorActionPreference='Stop'; $p=" + literal(path) + "; $f=Get-Item -LiteralPath $p; "
                    "@{sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower();size=$f.Length} | ConvertTo-Json -Compress").stdout
    return json.loads(output.lstrip("\ufeff"))


def _sftp(ws, name, local, remote, direction):
    directory, record = connection(ws, name)
    # SFTP batch syntax is a separate quoting language, never a shell command.
    def quote(value):
        value = str(value)
        if any(c in value for c in "\r\n\0"):
            raise Failure("invalid SFTP path", 2)
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    remote = str(remote).replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", remote):
        remote = "/" + remote # Windows OpenSSH's absolute SFTP path syntax.
    batch = ("put " + quote(local) + " " + quote(remote) if direction == "upload" else
             "get " + quote(remote) + " " + quote(local)) + "\n"
    args = devbox.ssh_command(directory, record)
    args[0] = os.environ["WB_SFTP"]
    args[args.index("-p")] = "-P"
    args[-1:-1] = ["-b", "-"]
    proc = subprocess.run([str(v) for v in args], input=batch, capture_output=True, text=True, timeout=600)
    if proc.returncode:
        raise Failure(proc.stderr.strip() or "SFTP transfer failed", proc.returncode)


def upload(ws, name, local, remote):
    local = Path(local)
    before = {"sha256": digest(local), "size": local.stat().st_size}
    _sftp(ws, name, local, remote, "upload")
    after = remote_file(ws, name, remote)
    if before != after or before != {"sha256": digest(local), "size": local.stat().st_size}:
        raise Failure("upload hash/size mismatch; no task was started", 74, expected=before, observed=after)
    return {"local": str(local), "remote": remote, **after}


def download(ws, name, remote, local, expected=None):
    local = Path(local)
    before = remote_file(ws, name, remote)
    if expected and before != expected:
        raise Failure("guest output differs from its manifest", 74, expected=expected, observed=before)
    if local.exists():
        if {"sha256": digest(local), "size": local.stat().st_size} == before:
            return {"local": str(local), "remote": remote, "resumed": True, **before}
        raise Failure("download refuses to overwrite an existing output", 2)
    local.parent.mkdir(parents=True, exist_ok=True)
    temporary = local.with_name(local.name + ".partial-" + identity())
    _sftp(ws, name, temporary, remote, "download")
    after = {"sha256": digest(temporary), "size": temporary.stat().st_size}
    if before != after or before != remote_file(ws, name, remote):
        raise Failure("download hash/size mismatch; partial output retained", 74, expected=before, observed=after)
    temporary.rename(local)
    return {"local": str(local), "remote": remote, **after}


def job_id(value):
    if not re.fullmatch(r"op-[0-9a-f]{32}", value):
        raise Failure("invalid Windows job ID", 2)
    return value


def payloads(ws, name):
    source = Path(os.environ["WB_DEVBOX_PAYLOADS"])
    files = [source / name for name in ["Control.ps1", "Task.ps1", "LoadedIdentity.cs"]]
    identity = __import__("hashlib").sha256("".join(digest(p) for p in files).encode()).hexdigest()
    remote = ROOT + "\\control\\" + identity
    invoke(ws, name, "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Path " + literal(remote) + " -Force | Out-Null")
    for path in files:
        upload(ws, name, path, remote + "\\" + path.name)
    return remote


def submit(ws, name, operation_id, script, purpose, arguments=(), direct=False, metadata=None, inputs=None):
    if purpose not in PURPOSES:
        raise Failure("purpose must be build, install, desktop or system", 2)
    job_id(operation_id)
    script = Path(script).resolve(strict=True)
    if not script.is_file() or script.suffix.lower() != ".ps1":
        raise Failure("run requires a PowerShell script file", 2)
    directory, record = connection(ws, name)
    local = directory / "windows-jobs" / operation_id
    local.mkdir(parents=True, exist_ok=False)
    ws.journal(operation_id, {"kind": "windows-job", "name": name, "state": "preparing",
                              "operationId": operation_id, "purpose": purpose,
                              "localEvidence": str(local), "guestIdentity": record["identity"]})
    control = payloads(ws, name)
    remote = ROOT + "\\jobs\\" + operation_id
    invoke(ws, name, "$ErrorActionPreference='Stop'; if(Test-Path -LiteralPath " + literal(remote) +
           ") {throw 'Guest job already exists'}; New-Item -ItemType Directory -Path " + literal(remote) + " | Out-Null")
    transfers = [upload(ws, name, script, remote + "\\payload.ps1")]
    for filename, path in (inputs or {}).items():
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", filename):
            raise Failure("invalid staged input filename", 2)
        transfers.append(upload(ws, name, path, remote + "\\" + filename))
    request = {"schemaVersion": 1, "operationId": operation_id, "guestIdentity": record["identity"],
               "purpose": purpose, "script": remote + "\\payload.ps1", "scriptSha256": transfers[0]["sha256"],
               "scriptSize": transfers[0]["size"], "arguments": list(arguments), "metadata": metadata or {},
               "inputs": [{"path": f["remote"], "sha256": f["sha256"], "size": f["size"]} for f in transfers[1:]]}
    write_json(local / "request.json", request)
    transfers.append(upload(ws, name, local / "request.json", remote + "\\request.json"))
    receipt = {"schemaVersion": 1, "kind": "windows-job", "state": "staged", "name": name,
               "operationId": operation_id, "guestIdentity": record["identity"], "remote": remote,
               "control": control, "requestSha256": transfers[-1]["sha256"], "transfers": transfers,
               "purpose": purpose, "metadata": metadata or {}}
    write_json(local / "job.json", receipt)
    ws.journal(operation_id, receipt)
    action = "direct" if direct else "start"
    result = _control(ws, name, receipt, action)
    write_json(local / "observation.json", result)
    ws.journal(operation_id, {**receipt, "state": result["state"], "observation": result})
    return result


def _control(ws, name, receipt, action):
    script = "& " + literal(receipt["control"] + "\\Control.ps1") + " -Action " + literal(action) + " -JobRoot " + literal(receipt["remote"]) + " -RequestSha256 " + literal(receipt["requestSha256"])
    proc = invoke(ws, name, script, check=False)
    try:
        result = json.loads(proc.stdout.lstrip("\ufeff"))
    except ValueError:
        raise Failure(proc.stderr.strip() or proc.stdout.strip() or "guest task returned no receipt", proc.returncode or 1)
    # SSH's Windows process result truncates codes above 255; preserve the JSON code.
    if proc.returncode and not result.get("exitCode"):
        raise Failure("transport failed after guest observation", proc.returncode, observation=result)
    return result


def job(ws, name, identifier, action, operation_id):
    job_id(identifier)
    directory, record = connection(ws, name)
    local = directory / "windows-jobs" / identifier
    receipt = json.loads((local / "job.json").read_text())
    if receipt["guestIdentity"] != record["identity"] or receipt["operationId"] != identifier:
        raise Failure("Windows job belongs to a different guest", 2)
    result = _control(ws, name, receipt, action)
    write_json(local / "observation.json", result)
    ws.journal(operation_id, {"kind": "windows-job-" + action, "name": name, "jobId": identifier, "observation": result})
    return result


def wait(ws, name, identifier, allow_reboot=False):
    """The detached host worker observes a guest task; the client can disconnect."""
    while True:
        result = job(ws, name, identifier, "status", identifier)
        if result["state"] not in {"running", "queued"}:
            if allow_reboot and result["state"] == "reboot-required":
                return result
            if result.get("exitCode"):
                raise Failure("Windows task " + result["state"], result["exitCode"], jobId=identifier, observation=result)
            return result
        time.sleep(5)


def windows_relative(value):
    """Reject Windows aliasing, ADS and device names before creating an archive."""
    value = str(value).replace("\\", "/")
    path = PureWindowsPath(value)
    if path.is_absolute() or path.drive or ".." in path.parts or not path.parts:
        raise Failure("unsafe Windows source path", 2)
    for part in path.parts:
        if (part[-1:] in {".", " "} or any(c in part for c in ':<>"|?*\r\n\0') or
                re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part)):
            raise Failure("source path has Windows alias/device semantics", 2, path=value)
    return "/".join(path.parts)


def mirror_sources(ws, name, components, mode, operation_id):
    from . import builds
    directory = ws.state / "windows-sources" / operation_id
    directory.mkdir(parents=True)
    sources = {}
    files = {}
    with ws.repo_locks(components):
        for component in components:
            original = ws.validate_checkout(component)
            exported = directory / "sources" / component
            info = builds._export(original, exported, mode, ws.repos[component]["pin"]["rev"],
                                  recursive=component in {"dxvk", "vkd3d-proton"})
            info["narHash"] = run([os.environ["WB_NIX"], "hash", "path", "--sri", exported]).stdout.strip()
            relative = windows_relative(ws.repos[component]["path"])
            sources[component] = {"relativePath": relative, "canonicalUrl": ws.repos[component]["url"], **info}
            for path in sorted(exported.rglob("*")):
                if path.is_symlink() and path.is_dir():
                    raise Failure("Windows mirror cannot silently omit a source directory symlink", 3, path=str(path))
                if path.is_file():
                    target = windows_relative(relative + "/" + str(path.relative_to(exported)))
                    key = target.casefold()
                    file = {"path": target, "sha256": digest(path), "size": path.stat().st_size}
                    if key in files and files[key][0] != file:
                        raise Failure("conflicting/case-aliased Windows snapshot paths", 2, path=target)
                    files[key] = (file, path)
    archive = directory / "sources.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as output:
        for file, path in sorted(files.values(), key=lambda item: item[0]["path"]):
            output.write(path, file["path"])
    remote = ROOT + "\\jobs\\" + operation_id
    spec = {"schemaVersion": 1, "operationId": operation_id, "mode": mode, "sources": sources,
            "files": [file for file, _ in sorted(files.values(), key=lambda item: item[0]["path"])],
            "archive": remote + "\\sources.zip", "archiveSha256": digest(archive), "archiveSize": archive.stat().st_size}
    write_json(directory / "snapshot.json", spec)
    result = submit(ws, name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "Snapshot.ps1", "build",
                    [remote + "\\snapshot.json"], inputs={"snapshot.json": directory / "snapshot.json", "sources.zip": archive},
                    metadata={"kind": "mirror", "sources": sources})
    if result.get("exitCode"):
        raise Failure("source mirror submission failed", result["exitCode"], observation=result)
    wait(ws, name, operation_id)
    return {"state": "mirrored", "operationId": operation_id, "sourceRoot": r"C:\WinBoatDev\src" + "\\" + operation_id,
            "sources": sources, "snapshotSha256": digest(directory / "snapshot.json"), "archiveSha256": spec["archiveSha256"]}


def build(ws, name, target, configuration, mode, operation_id):
    from . import builds
    plan = builds.plan(ws, target, configuration, mode)
    recipe = plan.get("dispatch", {})
    if not recipe.get("commands") or target not in {"dxvk-engine-x64", "dxvk-engine-x86", "vkd3d-engine-x64", "vkd3d-engine-x86"}:
        raise Failure("Stage 4 target still needs its complete fixed input/recipe closure", 3, plan=plan, backend="devbox")
    observed = devbox.guest_status(ws, name, operation_id)
    if observed.get("phase") != "verified":
        raise Failure("component build requires a verified guest toolchain", 3)
    if any(value in {"shader-libraries", "pdb"} for value in recipe.get("outputs", [])):
        raise Failure("component recipe must enumerate every required output before execution", 3, target=target)
    mirror = mirror_sources(ws, name, plan["contract"]["repositories"], mode, identity())
    build_root = r"C:\WinBoatDev\build" + "\\" + operation_id
    component = "dxvk" if target.startswith("dxvk") else "vkd3d-proton"
    sources = mirror["sources"]
    source_root = mirror["sourceRoot"]
    bindings = {"@sourceDirectory@": source_root + "\\" + sources[component]["relativePath"].replace("/", "\\"),
                "@buildDirectory@": build_root,
                "@nativeFile@": source_root + "\\" + sources[component]["relativePath"].replace("/", "\\") + "\\nix\\" + Path(recipe["nativeFile"]).name}
    if "helios" in sources:
        bindings["@heliosSourceDirectory@"] = source_root + "\\" + sources["helios"]["relativePath"].replace("/", "\\")
    commands = []
    for command in recipe["commands"]:
        row = []
        for value in command:
            for token, bound in bindings.items():
                value = value.replace(token, bound)
            if re.search(r"@[A-Za-z]+@", value):
                raise Failure("unbound Windows recipe token", 2, token=value)
            row.append(value)
        commands.append(row)
    remote = ROOT + "\\jobs\\" + operation_id
    specification = {"schemaVersion": 1, "operationId": operation_id, "target": target,
                     "architecture": recipe["architecture"], "configuration": configuration,
                     "sourceRoot": source_root, "buildRoot": build_root, "sources": sources,
                     "commands": commands, "outputs": recipe["outputs"], "provisionLockSha256": observed["lockSha256"]}
    local = ws.state / "windows-builds" / operation_id
    write_json(local / "build.json", specification)
    write_json(local / "plan.json", plan)
    receipt = {"kind": "windows-build", "name": name, "state": "building", "target": target,
               "mirror": mirror, "specification": str(local / "build.json"), "windowsJobId": operation_id}
    ws.journal(operation_id, receipt)
    submit(ws, name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "GuestBuild.ps1", "build",
           [remote + "\\build.json"], metadata={"kind": "build", "target": target}, inputs={"build.json": local / "build.json"})
    wait(ws, name, operation_id)
    return collect_build(ws, name, operation_id, receipt, plan, local, sources, configuration, mode)


def collect_build(ws, name, operation_id, receipt, plan, local, sources, configuration, mode):
    from . import builds
    remote = ROOT + "\\jobs\\" + operation_id
    result_path = local / "build-result.json"
    download(ws, name, remote + "\\build-result.json", result_path)
    result = json.loads(result_path.read_text(encoding="utf-8-sig"))
    if result.get("schemaVersion") != 1 or result.get("state") != "built" or result.get("operationId") != operation_id:
        raise Failure("unexpected guest build result", 74)
    if result.get("output") != r"C:\WinBoatDev\build" + "\\" + operation_id + "\\artifact":
        raise Failure("guest build output escaped its operation directory", 74)
    export = ws.out / "guest" / operation_id
    manifest_path = export / "manifest.json"
    if manifest_path.exists():
        verified = builds.verify(manifest_path)
        existing = json.loads(manifest_path.read_text())
        if existing["artifactId"] != operation_id or existing["target"] != plan["target"] or existing["sources"] != sources:
            raise Failure("existing artifact belongs to another build identity", 74)
        receipt.update(state="succeeded", exitCode=0, manifest=str(manifest_path), manifestSha256=verified["manifestSha256"], collected=True)
        ws.journal(operation_id, receipt)
        return receipt
    seen = set()
    for file in result["files"]:
        relative = windows_relative(file["path"])
        if relative.casefold() in seen:
            raise Failure("duplicate guest output path", 74)
        seen.add(relative.casefold())
        download(ws, name, result["output"] + "\\" + relative.replace("/", "\\"), export / "files" / relative,
                 expected={"sha256": file["sha256"], "size": file["size"]})
    files = builds._files(export / "files")
    required = {windows_relative(path).casefold() for path in plan["dispatch"]["outputs"]}
    if not required.issubset(seen):
        raise Failure("guest result omitted a required component output", 74, missing=sorted(required-seen))
    manifest = {"schemaVersion": 1, "artifactId": operation_id, "target": plan["target"], "abi": plan["contract"]["abi"],
                "configuration": configuration, "mode": mode, "sources": sources, "dependencies": {k: v["revision"] for k,v in sources.items()},
                "toolchain": {"lockSha256": plan["lockSha256"], "provisionLockSha256": devbox.load(ws, name)[1]["provisioning"]["lockSha256"], "observed": result["toolchain"]},
                "files": files, "licenses": [f["path"] for f in files if f["path"].startswith("licenses/")],
                "symbols": [f["path"] for f in files if f["path"].endswith(".pdb")], "provenance": {"operationId": operation_id, "guest": name, "job": remote},
                "state": "built", "installed": False, "loaded": False}
    images_path = export / "files" / "images.json"
    manifest["images"] = json.loads(images_path.read_text(encoding="utf-8-sig")) if images_path.exists() else []
    manifest["imageVerification"] = "architecture-and-crt-inspected" if manifest["images"] else "unavailable-in-earlier-operation"
    manifest["embeddedSymbols"] = [file["path"] for file in manifest["images"] if file.get("embeddedCodeView")]
    manifest["recipe"] = {"rootRevision": git(ws.root, "rev-parse", "HEAD").stdout.strip(),
                          "rootDiffSha256": __import__("hashlib").sha256(git(ws.root, "diff", "--binary", "HEAD").stdout.encode()).hexdigest(),
                          "controlPlaneStorePath": os.environ["WB_OPERATION_SOURCES"],
                          "sharedOperationsNarHash": run([os.environ["WB_NIX"], "hash", "path", "--sri", Path(os.environ["WB_DEVBOX_PAYLOADS"]).parent]).stdout.strip()}
    if not manifest["licenses"]:
        raise Failure("Windows artifact lacks retained license notices", 74)
    write_json(manifest_path, manifest)
    for path in export.rglob("*"):
        if path.is_file():
            path.chmod(path.stat().st_mode & ~0o222)
    receipt.update(state="succeeded", exitCode=0, manifest=str(manifest_path), manifestSha256=digest(manifest_path))
    ws.journal(operation_id, receipt)
    return receipt


def dispatch(ws, args, operation_id):
    if args.action == "run":
        return submit(ws, args.name, operation_id, args.script, args.purpose, args.argument, args.direct)
    if args.action == "job":
        return job(ws, args.name, args.id, args.job_action, operation_id)
    if args.action == "mirror":
        if not args.repo:
            raise Failure("mirror requires explicit --repo selections", 2)
        components = list(dict.fromkeys(args.repo))
        if set(components) - set(ws.repos):
            raise Failure("unknown source repository", 2)
        return mirror_sources(ws, args.name, components, args.mode, operation_id)
    if args.action == "registry":
        return registry(ws, args.name, args.registry_action, operation_id)
    if args.action == "install":
        if args.rollback:
            if args.manifest or args.resume:
                raise Failure("rollback cannot also specify manifest/resume", 2)
            directory, _ = connection(ws, args.name)
            prior = json.loads((directory / "windows-jobs" / job_id(args.rollback) / "job.json").read_text())
            if prior["metadata"].get("kind") != "install":
                raise Failure("rollback requires an install transaction ID", 2)
            submit(ws, args.name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "Rollback.ps1", "install", [args.rollback])
            return wait(ws, args.name, operation_id)
        return install(ws, args.name, args.manifest, operation_id, args.fixture, args.failure_after_copy, args.resume)
    if args.action == "build":
        if args.collect:
            identifier = job_id(args.collect)
            directory, record = connection(ws, args.name)
            receipt = json.loads((directory / "windows-jobs" / identifier / "job.json").read_text())
            if receipt["metadata"].get("kind") != "build" or receipt["guestIdentity"] != record["identity"]:
                raise Failure("collection requires this guest's component build job", 2)
            observation = job(ws, args.name, identifier, "status", operation_id)
            if observation["state"] != "succeeded":
                raise Failure("guest build is not complete", observation.get("exitCode") or 75, observation=observation)
            local = ws.state / "windows-builds" / identifier
            plan = json.loads((local / "plan.json").read_text())
            spec = json.loads((local / "build.json").read_text())
            return collect_build(ws, args.name, identifier, receipt, plan, local, spec["sources"], plan["configuration"], plan["mode"])
        if not args.target:
            raise Failure("devbox build requires --target or --collect", 2)
        return build(ws, args.name, args.target, args.configuration, args.mode, operation_id)
    raise Failure("unknown Windows control operation", 2)


def registry(ws, name, mode, operation_id):
    submit(ws, name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "Registry.ps1", "system", [mode])
    try:
        observation = wait(ws, name, operation_id)
    except Failure as exc:
        if exc.code != 76 or "observation" not in exc.details:
            raise
        observation = exc.details["observation"]
    local = ws.state / "devboxes" / name / "windows-jobs" / operation_id / "registry-result.json"
    download(ws, name, ROOT + "\\jobs\\" + operation_id + "\\registry-result.json", local)
    result = json.loads(local.read_text(encoding="utf-8-sig"))
    host = devbox.status(ws, name)
    result["host"] = {"runtimeState": host["state"], "loaded": host.get("loaded", False),
                      "hostArtifact": devbox.load(ws, name)[1]["hostArtifact"]}
    host_path = devbox.load(ws, name)[0] / "host-observation.json"
    if host.get("loaded") and host_path.exists():
        result["host"]["observation"] = json.loads(host_path.read_text())
    result["operationId"] = operation_id
    result["task"] = {key: value for key, value in observation.items() if key not in {"logs"}}
    result["exitCode"] = observation.get("exitCode", 0)
    if result["exitCode"]:
        result["verificationError"] = "Full selected stack and kernel loaded-image evidence are still required"
    write_json(local, result)
    return result


def install(ws, name, manifest_path, operation_id, fixture=False, failure_after_copy=False, resume=None):
    if resume:
        directory, _ = connection(ws, name)
        prior = json.loads((directory / "windows-jobs" / job_id(resume) / "job.json").read_text())
        if prior["metadata"].get("kind") != "install":
            raise Failure("resume requires an installation transaction ID", 2)
        job(ws, name, resume, "resume", operation_id)
        return wait(ws, name, resume, allow_reboot=True)
    if not manifest_path:
        raise Failure("install requires an exact package --manifest or --resume transaction", 2)
    manifest_path = ws.resolve(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), list):
        raise Failure("unsupported install package schema", 2)
    if fixture:
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", manifest.get("fixtureId", "")):
            raise Failure("fixture requires a bounded fixtureId", 2)
    else:
        if (manifest.get("architecture") != "x64" or set(manifest.get("applicationArchitectures", [])) != {"x64", "x86"}
                or manifest.get("signing", {}).get("mode") != "test" or not manifest.get("source")
                or any(not re.fullmatch(r"[0-9a-f]{40}", rev) for rev in manifest["source"].values())):
            raise Failure("complete x64/WoW64 package, signing identity and immutable source commits are required", 2)
    local = ws.state / "windows-installs" / operation_id
    local.mkdir(parents=True)
    archive = local / "bundle.zip"
    seen = set()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as output:
        for file in manifest["files"]:
            relative = windows_relative(file["path"])
            if relative.casefold() in seen or relative.casefold() == "manifest.json":
                raise Failure("duplicate/reserved install package path", 2)
            seen.add(relative.casefold())
            path = manifest_path.parent / relative
            if not path.resolve().is_relative_to(manifest_path.parent.resolve()) or not path.is_file():
                raise Failure("package file escaped its root or is missing", 2)
            if digest(path) != file["sha256"].lower() or path.stat().st_size != file["size"]:
                raise Failure("install package hash/size mismatch; guest state was not changed", 74, path=relative)
            output.write(path, relative)
        output.write(manifest_path, "manifest.json")
    if not fixture and "payload/install-helios.ps1" not in seen:
        raise Failure("package must manifest its shared legacy installer", 2)
    remote = ROOT + "\\jobs\\" + operation_id
    spec = {"schemaVersion": 1, "kind": "fixture" if fixture else "helios", "operationId": operation_id,
            "archive": remote + "\\bundle.zip", "archiveSha256": digest(archive), "archiveSize": archive.stat().st_size,
            "manifestSha256": digest(manifest_path), "failureAfterCopy": failure_after_copy}
    write_json(local / "install.json", spec)
    submit(ws, name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "Install.ps1", "install",
           [remote + "\\install.json"], metadata={"kind": "install", "manifestSha256": spec["manifestSha256"],
             "requested": manifest, "built": {"files": manifest["files"]}}, inputs={"install.json": local / "install.json", "bundle.zip": archive})
    result = wait(ws, name, operation_id, allow_reboot=True)
    result["transactionId"] = operation_id
    result["installedVerified"] = False
    result["loadedVerified"] = False
    return result
