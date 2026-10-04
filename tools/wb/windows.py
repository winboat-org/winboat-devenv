"""Authenticated Windows transport and durable jobs shared by CLI and MCP."""
import base64
import json
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import struct
import time
import zipfile

from . import devbox
from .common import Failure, digest, git, identity, locked, run, write_json

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
    files = [source / name for name in ["Control.ps1", "Task.ps1", "LoadedIdentity.cs", "Toolchain.ps1"]]
    identity = __import__("hashlib").sha256("".join(digest(p) for p in files).encode()).hexdigest()
    remote = ROOT + "\\control\\" + identity
    _, guest = connection(ws, name)
    # Concurrent builds share this content-addressed bundle. Publish it once;
    # reopening a script being read by Windows can fail with a sharing error.
    with locked(ws.state/'locks'/('windows-control-'+guest['identity']+'.lock')):
        names = ','.join(literal(path.name) for path in files)
        script = ("$ErrorActionPreference='Stop'; $root="+literal(remote)+"; "
                  "New-Item -ItemType Directory -Path $root -Force | Out-Null; "
                  "@{files=@(foreach($name in @("+names+")) {$path=Join-Path $root $name; "
                  "if(Test-Path -LiteralPath $path -PathType Leaf) {@{name=$name;size=(Get-Item $path).Length;"
                  "sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLower()}}})} | ConvertTo-Json -Depth 5 -Compress")
        existing = {entry['name']: entry for entry in json.loads(invoke(ws, name, script).stdout.lstrip('\ufeff'))['files']}
        for path in files:
            entry = existing.get(path.name)
            if entry:
                if entry['sha256'] != digest(path) or entry['size'] != path.stat().st_size:
                    raise Failure('published Windows control bundle changed', 74, path=path.name)
                continue
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


def windows_source_files(root):
    """Materialize bounded internal Git links into a Windows file table."""
    root = Path(root)
    boundary = root.resolve()
    files, links = [], []
    def visit(directory, relative, ancestors):
        resolved = directory.resolve()
        if not resolved.is_relative_to(boundary) or resolved in ancestors:
            raise Failure("source directory link escapes or cycles within its snapshot", 2)
        for path in sorted(directory.iterdir()):
            name = relative / path.name
            if path.is_symlink():
                if not path.resolve().is_relative_to(boundary) or not path.exists():
                    raise Failure("source link escapes or is broken", 2, path=str(name))
                links.append({"path": str(name), "target": os.readlink(path), "materialized": "directory" if path.is_dir() else "file"})
            if path.is_dir():
                visit(path, name, ancestors | {resolved})
            elif path.is_file():
                files.append((str(name), path))
            else:
                raise Failure("unsupported source file type", 2, path=str(name))
    visit(root, Path(), set())
    return files, links


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
                                  gitlinks=builds.selected_gitlinks(ws, component) if component in {"dxvk", "vkd3d-proton", "dxil-spirv", "clvk-helios"} else ())
            info["narHash"] = run([os.environ["WB_NIX"], "hash", "path", "--sri", exported]).stdout.strip()
            exported_files, info["windowsLinks"] = windows_source_files(exported)
            relative = windows_relative(ws.repos[component]["path"])
            sources[component] = {"relativePath": relative, "canonicalUrl": ws.repos[component]["url"], **info}
            for exported_relative, path in exported_files:
                target = windows_relative(relative + "/" + exported_relative)
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


def mirror_build_tools(ws, name, kind="widl"):
    """Build the locked Windows prerequisite in Nix, then verify its local mirror."""
    operation_id = identity()
    directory = ws.state / "windows-tools" / operation_id
    directory.mkdir(parents=True)
    expression = {"widl": "WB_WINDOWS_TOOLS_EXPRESSION", "cargo": "WB_WINDOWS_RUST_EXPRESSION",
                  "utilities": "WB_WINDOWS_UTILITIES_EXPRESSION", "clvk": "WB_WINDOWS_COMPONENT_EXPRESSION",
                  "mesa": "WB_WINDOWS_COMPONENT_EXPRESSION"}[kind]
    command = [os.environ["WB_NIX"], "build", "--json", "--out-link", str(directory / "result"),
               "--file", os.environ[expression], "--argstr", "nixpkgsPath", os.environ["WB_NIXPKGS"]]
    if kind == "cargo":
        command += ["--argstr", "sourcePath", str(ws.validate_checkout("helios"))]
    if kind in {"clvk", "mesa"}:
        command += ["--argstr", "sourcePath", str(ws.validate_checkout("clvk-helios" if kind == 'clvk' else 'mesa-helios'))]
    with (directory / "build.log").open("w") as log:
        proc = subprocess.run(command, stdout=subprocess.PIPE, stderr=log, text=True)
    if proc.returncode:
        raise Failure("Windows prerequisite Nix build failed", proc.returncode, log=str(directory / "build.log"))
    built = json.loads(proc.stdout)
    write_json(directory / "nix-build.json", built)
    output = Path(built[0]["outputs"]["out"])
    files = []
    paths = []
    seen = set()
    for path in sorted(output.rglob('*')):
        if not path.is_file():
            continue
        relative = windows_relative(str(path.relative_to(output)))
        if relative.casefold() in seen:
            raise Failure('Windows prerequisite has case-aliased files', 74, path=relative)
        seen.add(relative.casefold())
        files.append({'path': relative, 'sha256': digest(path), 'size': path.stat().st_size})
        paths.append((path, relative))
    guest_directory, guest_record = connection(ws, name)
    for previous in sorted((ws.state/'windows-tools').glob('*/nix-build.json'), key=lambda p:p.stat().st_mtime, reverse=True):
        if previous.parent == directory:
            continue
        prior_build = json.loads(previous.read_text())
        if prior_build != built:
            continue
        snapshot_path = previous.parent/'snapshot.json'
        original_job = guest_directory/'windows-jobs'/previous.parent.name/'job.json'
        if not snapshot_path.exists() or not original_job.exists():
            continue
        original = json.loads(original_job.read_text())
        if original['guestIdentity'] != guest_record['identity'] or original['metadata'].get('toolKind') != kind:
            continue
        prior_snapshot = json.loads(snapshot_path.read_text())
        hashes = [t['sha256'] for t in original['transfers'] if t['remote'].endswith('\\snapshot.json')]
        if hashes != [digest(snapshot_path)] or prior_snapshot['files'] != files:
            continue
        observation = job(ws, name, previous.parent.name, 'status', operation_id)
        if observation['state'] in {'queued', 'running'}:
            try:
                observation = wait(ws, name, previous.parent.name)
            except Failure as exc:
                if 'observation' not in exc.details:
                    raise
                continue
        if observation['state'] != 'succeeded':
            continue
        reused = {'operationId': previous.parent.name, 'kind': kind,
            'root': r'C:\WinBoatDev\src'+'\\'+previous.parent.name, 'derivation': built[0]['drvPath'],
            'storePath': str(output), 'narHash': run([os.environ['WB_NIX'],'hash','path','--sri',output]).stdout.strip(),
            'files': files, 'snapshotSha256': digest(snapshot_path), 'reusedVerifiedMirror': True}
        write_json(directory/'mirror.json', reused)
        return reused
    archive = directory / "sources.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, strict_timestamps=False) as zipped:
        for path, relative in paths:
            zipped.write(path, relative)
    remote = ROOT + "\\jobs\\" + operation_id
    spec = {"schemaVersion": 1, "operationId": operation_id, "mode": "locked-tools", "sources": {},
            "files": files, "archive": remote + "\\sources.zip", "archiveSha256": digest(archive), "archiveSize": archive.stat().st_size}
    write_json(directory / "snapshot.json", spec)
    submit(ws, name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "Snapshot.ps1", "build",
           [remote + "\\snapshot.json"], inputs={"snapshot.json": directory / "snapshot.json", "sources.zip": archive},
           metadata={"kind": "build-prerequisites", "toolKind": kind, "derivation": built[0]["drvPath"]})
    wait(ws, name, operation_id)
    result = {"operationId": operation_id, "kind": kind, "root": r"C:\WinBoatDev\src" + "\\" + operation_id,
            "derivation": built[0]["drvPath"], "storePath": str(output),
            "narHash": run([os.environ["WB_NIX"], "hash", "path", "--sri", output]).stdout.strip(),
            "files": files, "snapshotSha256": digest(directory / "snapshot.json")}
    write_json(directory/'mirror.json', result)
    return result


def validate_dependency_sources(ws, manifest, mode):
    sources = manifest['sources']
    if set(sources) - set(ws.paths):
        raise Failure('dependency names an unknown source repository', 2)
    with ws.repo_locks(sources):
        for source, snapshot in sources.items():
            if git(ws.paths[source], 'rev-parse', 'HEAD').stdout.strip() != snapshot['revision']:
                raise Failure('dependency source revision differs from the selected checkout', 2, source=source)
            if mode == 'release' and (ws.repos[source]['pin']['rev'] != snapshot['revision']
                    or git(ws.paths[source], 'status', '--porcelain=v1', '--untracked-files=all').stdout):
                raise Failure('release dependency requires a clean checkout at its declared pin', 2, source=source)


def build(ws, name, target, configuration, mode, operation_id, dependency_manifests=()):
    from . import builds
    plan = builds.plan(ws, target, configuration, mode)
    recipe = plan.get("dispatch", {})
    if not recipe.get("commands") or target not in {"dxvk-engine-x64", "dxvk-engine-x86", "vkd3d-engine-x64", "vkd3d-engine-x86", "helios-guest-x64", "helios-guest-x86", "mesa-guest-x64", "mesa-guest-x86", "clvk-helios", "helios-development-package"}:
        raise Failure("Stage 4 target still needs its complete fixed input/recipe closure", 3, plan=plan, backend="devbox")
    if not recipe.get("backendAvailable") and mode != "development":
        raise Failure("Stage 4 candidate backend requires explicit development mode until native acceptance passes", 3, target=target)
    observed = devbox.guest_status(ws, name, operation_id)
    if observed.get("phase") != "verified":
        raise Failure("component build requires a verified guest toolchain", 3,
                      phase=observed.get("phase"), guestError=observed.get("error"),
                      observation=str(devbox.load(ws, name)[0] / "guest-observation.json"))
    if any(value in {"shader-libraries", "pdb"} for value in recipe.get("outputs", [])):
        raise Failure("component recipe must enumerate every required output before execution", 3, target=target)
    prerequisites = [mirror_build_tools(ws, name)] if target.startswith("vkd3d") else []
    component_dependencies = []
    selected_dependencies = {}
    for path in dependency_manifests:
        path = ws.resolve(path)
        builds.verify(path)
        manifest = json.loads(path.read_text())
        dependency_target = manifest['target']
        if dependency_target in selected_dependencies or manifest['configuration'] != configuration or manifest['provenance']['guest'] != name:
            raise Failure('dependency manifest has duplicate target, configuration or guest mismatch', 2)
        directory, guest_record = connection(ws, name)
        original = json.loads((directory/'windows-jobs'/job_id(manifest['artifactId'])/'job.json').read_text())
        if original['guestIdentity'] != guest_record['identity']:
            raise Failure('dependency artifact belongs to another guest identity', 2)
        if mode == 'release' and (manifest['mode'] != 'release' or any(s.get('diffSha256') or s.get('untracked') for s in manifest['sources'].values())):
            raise Failure('release package requires clean pinned dependency builds', 2)
        selected_dependencies[dependency_target] = (path, manifest)
    def component_dependency(component_target):
        if component_target in selected_dependencies:
            manifest_path, manifest = selected_dependencies.pop(component_target)
            current = builds.plan(ws, component_target, configuration, mode)
            validate_dependency_sources(ws, manifest, mode)
            if current['dispatch']['outputs'] != json.loads((ws.state/'windows-builds'/manifest['artifactId']/'build.json').read_text())['outputs']:
                raise Failure('dependency outputs differ from the selected recipe', 2)
        else:
            dependency = build(ws, name, component_target, configuration, mode, identity())
            manifest_path = Path(dependency['manifest'])
            manifest = json.loads(manifest_path.read_text())
        component_dependencies.append({'target': component_target, 'artifactId': manifest['artifactId'],
            'manifestSha256': digest(manifest_path), 'files': manifest['files'], 'sources': manifest['sources'],
            'componentDependencies': manifest.get('componentDependencies', []), 'prerequisites': manifest.get('prerequisites', []),
            'root': r'C:\WinBoatDev\build'+'\\'+manifest['artifactId']+'\\artifact'})
    if target.startswith("mesa-guest"):
        prerequisites = [mirror_build_tools(ws, name, "utilities"), mirror_build_tools(ws, name, "mesa")]
    if target == "clvk-helios":
        prerequisites = [mirror_build_tools(ws, name, "utilities"), mirror_build_tools(ws, name, "clvk")]
    if target == 'helios-development-package':
        for component_target in ['helios-guest-x64', 'mesa-guest-x64', 'mesa-guest-x86', 'clvk-helios']:
            component_dependency(component_target)
    elif target.startswith("helios-guest"):
        prerequisites = [mirror_build_tools(ws, name, "cargo")]
        architectures = ["x64", "x86"] if target.endswith("x64") else ["x86"]
        for architecture in architectures:
            for engine in ["dxvk", "vkd3d"]:
                component_target = engine + "-engine-" + architecture
                component_dependency(component_target)
    if selected_dependencies:
        raise Failure('unused dependency manifests for this build target', 2, targets=sorted(selected_dependencies))
    mirror = mirror_sources(ws, name, plan["contract"]["repositories"], mode, identity())
    build_root = r"C:\WinBoatDev\build" + "\\" + operation_id
    component = "helios" if target.startswith("helios") else "clvk-helios" if target.startswith("clvk") else "mesa-helios" if target.startswith("mesa") else "dxvk" if target.startswith("dxvk") else "vkd3d-proton"
    sources = mirror["sources"]
    source_root = mirror["sourceRoot"]
    bindings = {"@sourceDirectory@": source_root + "\\" + sources[component]["relativePath"].replace("/", "\\"),
                "@buildDirectory@": build_root,
                "@specification@": ROOT + "\\jobs\\" + operation_id + "\\build.json"}
    if recipe.get("nativeFile"):
        bindings["@nativeFile@"] = source_root + "\\" + sources[component]["relativePath"].replace("/", "\\") + "\\nix\\" + Path(recipe["nativeFile"]).name
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
                     "commands": commands, "outputs": recipe["outputs"], "outputArchitectures": recipe.get("outputArchitectures", {}),
                     "prerequisites": prerequisites, "componentDependencies": component_dependencies,
                     "preserveDirectories": recipe.get("preserveDirectories", []),
                     "provisionLockSha256": observed["lockSha256"]}
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


def extract_artifact(archive, destination, files):
    """Validate the entire member set before publishing any returned file."""
    table = {}
    for file in files:
        relative = windows_relative(file["path"])
        if relative.casefold() in table:
            raise Failure("case-aliased artifact file table", 74)
        table[relative.casefold()] = file
    destination = Path(destination)
    with zipfile.ZipFile(archive) as zipped:
        members = []
        seen = set()
        for member in zipped.infolist():
            relative = windows_relative(member.filename)
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise Failure("artifact archive contains a symlink", 74)
            # .NET writes empty directory entries with Windows separators.
            # Validate their paths before ignoring metadata; bytes and a file
            # table alias must never be concealed by a trailing separator.
            if member.filename.replace('\\', '/').endswith('/'):
                if member.file_size or relative.casefold() in table:
                    raise Failure("artifact archive contains an invalid directory entry", 74)
                continue
            if relative.casefold() in seen or relative.casefold() not in table:
                raise Failure("artifact archive member differs from its file table", 74)
            file = table[relative.casefold()]
            if relative != file["path"] or member.file_size != file["size"]:
                raise Failure("artifact archive path/size differs from its file table", 74)
            seen.add(relative.casefold())
            members.append(member)
        if seen != set(table):
            raise Failure("artifact archive omitted required files", 74)
        for member in members:
            file = table[windows_relative(member.filename).casefold()]
            path = destination / file["path"]
            if any(parent.is_symlink() for parent in [destination, *path.parents]):
                raise Failure("artifact collection encountered a directory symlink", 74)
            if path.exists():
                if path.is_symlink() or not path.is_file() or digest(path) != file["sha256"] or path.stat().st_size != file["size"]:
                    raise Failure("artifact collection refuses a divergent existing file", 74)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            # Failed verification must remain outside the manifest's files tree.
            partial = destination.parent / ("artifact.partial-" + identity())
            with zipped.open(member) as source, partial.open("xb") as output:
                __import__("shutil").copyfileobj(source, output)
            if digest(partial) != file["sha256"] or partial.stat().st_size != file["size"]:
                raise Failure("artifact archive content mismatch; partial file retained", 74)
            try:
                os.link(partial, path)
            except FileExistsError:
                if path.is_symlink() or not path.is_file() or digest(path) != file["sha256"] or path.stat().st_size != file["size"]:
                    raise Failure("artifact collection refuses a concurrent divergent file", 74)
            partial.unlink()


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
    if "archive" in result:
        archive = result["archive"]
        if archive["path"] != r"C:\WinBoatDev\build" + "\\" + operation_id + "\\artifact.zip":
            raise Failure("guest archive escaped its operation directory", 74)
        path = local / "artifact.zip"
        download(ws, name, archive["path"], path, expected={"sha256": archive["sha256"], "size": archive["size"]})
        extract_artifact(path, export / "files", result["files"])
    else:
        # A separate declared export operation archives older immutable results
        # without changing their original task inputs or build receipt.
        export_request = local / "export-operation.json"
        if export_request.exists():
            export_id = job_id(json.loads(export_request.read_text())["operationId"])
        else:
            export_id = identity()
            submit(ws, name, export_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "ExportArtifact.ps1", "build",
                   [ROOT + "\\jobs\\" + export_id + "\\original-build-result.json"],
                   inputs={"original-build-result.json": result_path}, metadata={"kind": "artifact-export", "originalOperationId": operation_id})
            write_json(export_request, {"operationId": export_id})
        wait(ws, name, export_id)
        archive_receipt = local / "artifact-export.json"
        download(ws, name, ROOT + "\\jobs\\" + export_id + "\\artifact-export.json", archive_receipt)
        archive = json.loads(archive_receipt.read_text(encoding="utf-8-sig"))
        if archive["originalOperationId"] != operation_id or archive["path"] != r"C:\WinBoatDev\build" + "\\" + export_id + "\\artifact.zip":
            raise Failure("supplemental export differs from its original artifact identity", 74)
        path = local / "artifact.zip"
        download(ws, name, archive["path"], path, expected={"sha256": archive["sha256"], "size": archive["size"]})
        # Retain any interrupted legacy transfers outside the manifest tree.
        for partial in (export / "files").rglob("*.partial-op-*"):
            destination = export / "partials" / partial.relative_to(export / "files")
            destination.parent.mkdir(parents=True, exist_ok=True)
            partial.rename(destination)
        extract_artifact(path, export / "files", result["files"])
    files = builds._files(export / "files")
    required = {windows_relative(path).casefold() for path in plan["dispatch"]["outputs"]}
    if not required.issubset(seen):
        raise Failure("guest result omitted a required component output", 74, missing=sorted(required-seen))
    manifest = {"schemaVersion": 1, "artifactId": operation_id, "target": plan["target"], "abi": plan["contract"]["abi"],
                "configuration": configuration, "mode": mode, "sources": sources, "dependencies": {k: v["revision"] for k,v in sources.items()},
                "toolchain": {"lockSha256": plan["lockSha256"], "provisionLockSha256": devbox.load(ws, name)[1]["provisioning"]["lockSha256"], "observed": result["toolchain"]},
                "files": files, "licenses": [f["path"] for f in files if f["path"].startswith("licenses/")],
                "symbols": [f["path"] for f in files if f["path"].endswith(".pdb")], "provenance": {"operationId": operation_id, "guest": name, "job": remote},
                "prerequisites": json.loads((local / "build.json").read_text()).get("prerequisites", []),
                "componentDependencies": json.loads((local / "build.json").read_text()).get("componentDependencies", []),
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
    if args.action == 'smoke':
        directory, record = connection(ws, args.name)
        original = json.loads((directory/'windows-jobs'/job_id(args.transaction)/'job.json').read_text())
        if original['guestIdentity'] != record['identity'] or original['metadata'].get('kind') != 'install' or original['metadata']['requested'].get('fixtureId'):
            raise Failure('graphics smoke requires this guest\'s complete package installation transaction', 2)
        local = directory/'windows-jobs'/operation_id
        specification = {'schemaVersion': 1, 'transactionId': args.transaction, 'manifestSha256': original['metadata']['manifestSha256'],
                         'manifest': original['metadata']['requested']}
        write_json(local/'graphics.json', specification)
        submit(ws, args.name, operation_id, Path(os.environ['WB_DEVBOX_PAYLOADS'])/'Graphics.ps1', 'desktop',
               [ROOT+'\\jobs\\'+operation_id+'\\graphics.json'], inputs={'graphics.json': local/'graphics.json'},
               metadata={'kind': 'graphics', 'transactionId': args.transaction, 'manifestSha256': specification['manifestSha256']})
        failure = None
        try:
            observation = wait(ws, args.name, operation_id)
        except Failure as exc:
            if 'observation' not in exc.details:
                raise
            failure = exc
            observation = exc.details['observation']
        path = local/'graphics-result.json'
        try:
            download(ws, args.name, ROOT+'\\jobs\\'+operation_id+'\\graphics-result.json', path)
        except (Failure, OSError):
            if failure:
                raise failure
            raise
        result = json.loads(path.read_text(encoding='utf-8-sig'))
        result['task'] = {k:v for k,v in observation.items() if k != 'logs'}
        result['exitCode'] = observation.get('exitCode', 0)
        write_json(path, result)
        return result
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
        return build(ws, args.name, args.target, args.configuration, args.mode, operation_id, args.dependency_manifest)
    raise Failure("unknown Windows control operation", 2)


def mapped_kernel_identity(image, base, read):
    """Compare resident executable PE sections, undoing x64 base relocations."""
    if len(image) < 64 or image[:2] != b'MZ':
        raise Failure('invalid kernel PE image', 76)
    def number(format, offset):
        try:
            return struct.unpack_from(format, image, offset)[0]
        except struct.error as exc:
            raise Failure('truncated kernel PE image', 76) from exc
    pe = number('<I', 60)
    if image[pe:pe+4] != b'PE\0\0' or number('<H', pe+4) != 0x8664 or number('<H', pe+24) != 0x20b:
        raise Failure('native x64 kernel PE required', 76)
    optional = pe+24
    table = optional+number('<H', pe+20)
    count = number('<H', pe+6)
    if count > 96 or table+count*40 > len(image):
        raise Failure('invalid kernel PE section table', 76)
    header_size = table+count*40
    header = read(0, header_size, 'header')
    if len(header) != header_size:
        raise Failure('incomplete mapped kernel header', 76)
    if header[pe:pe+24] != image[pe:pe+24] or header[optional+56:optional+60] != image[optional+56:optional+60]:
        return {'state': 'stale-mapped-image', 'sections': []}
    sections = []
    for index in range(count):
        at = table+40*index
        row = {'name': image[at:at+8].rstrip(b'\0').decode('ascii', errors='replace'),
               'rva': number('<I', at+12), 'size': number('<I', at+16),
               'raw': number('<I', at+20), 'flags': number('<I', at+36)}
        if row['raw']+row['size'] > len(image) or row['size'] > 32*1024*1024:
            raise Failure('invalid kernel PE section extent', 76)
        sections.append(row)
    delta = base-number('<Q', optional+24)
    reloc_rva = number('<I', optional+112+40)
    reloc_size = number('<I', optional+112+44)
    relocations = []
    if delta and reloc_size:
        candidates = [s for s in sections if s['rva'] <= reloc_rva and reloc_rva+reloc_size <= s['rva']+s['size']]
        if len(candidates) != 1:
            raise Failure('kernel relocations escaped a raw section', 76)
        start = candidates[0]['raw']+reloc_rva-candidates[0]['rva']; end = start+reloc_size
        while start < end:
            if start+8 > end:
                raise Failure('truncated kernel relocation block', 76)
            page, size = number('<I', start), number('<I', start+4)
            if size < 8 or size%2 or start+size > end:
                raise Failure('invalid kernel relocation block', 76)
            for offset in range(start+8, start+size, 2):
                entry = number('<H', offset)
                if entry >> 12:
                    relocations.append((page+(entry & 4095), entry >> 12))
            start += size
    result = []
    for index, section in enumerate(sections):
        if not section['flags'] & 0x20000000 or section['flags'] & 0x02000000 or not section['size']:
            continue
        mapped = bytearray(read(section['rva'], section['size'], str(index)))
        if len(mapped) != section['size']:
            raise Failure('incomplete mapped kernel section', 76)
        for address, kind in relocations:
            at = address-section['rva']
            if not 0 <= at < len(mapped):
                continue
            if kind != 10 or at+8 > len(mapped):
                raise Failure('unsupported resident kernel relocation', 76)
            value = (struct.unpack_from('<Q', mapped, at)[0]-delta) % (1 << 64)
            struct.pack_into('<Q', mapped, at, value)
        expected = image[section['raw']:section['raw']+section['size']]
        match = bytes(mapped) == expected
        result.append({'name': section['name'], 'rva': section['rva'], 'size': section['size'],
                       'normalizedSha256': __import__('hashlib').sha256(mapped).hexdigest(),
                       'expectedSha256': __import__('hashlib').sha256(expected).hexdigest(), 'matches': match})
    return {'state': 'mapped-code-matches' if result and all(s['matches'] for s in result) else 'stale-mapped-image' if result else 'unknown-no-resident-executable-section',
            'sections': result, 'discardableSectionsExcluded': True}


def observe_kernel(ws, name, result, operation_id):
    directory, record = connection(ws, name)
    observations = []
    for index, module in enumerate(result.get('kernelModules', [])):
        observed = dict(module, state='unknown')
        observations.append(observed)
        try:
            base = int(module['BaseAddress'], 16)
            if not base or not 0 < module['ImageSize'] < 32*1024*1024:
                raise Failure('invalid loaded kernel module extent', 76)
            path = module['Path']
            if path.lower().startswith('\\systemroot\\'):
                path = 'C:\\Windows\\' + path[len('\\SystemRoot\\'):]
            if path.startswith('\\??\\'):
                path = path[4:]
            relative = PureWindowsPath(path)
            if (relative.parent != PureWindowsPath(r'C:\Windows\System32\drivers')
                    and relative != PureWindowsPath(r'C:\ProgramData\WinBoatDev\fixture\wbdev-test.sys')
                    and not (relative.is_relative_to(PureWindowsPath(r'C:\Windows\System32\DriverStore\FileRepository'))
                             and relative.name.lower() == 'helios_kmd_render.sys')) or relative.suffix.lower() != '.sys':
                raise Failure('loaded kernel module disk path outside the driver directory', 76)
            local = directory / 'kernel-observations' / operation_id / str(index)
            local.mkdir(parents=True, exist_ok=True, mode=0o700)
            image_path = local / 'selected.sys'
            observed['disk'] = download(ws, name, path, image_path)
            observed['qmp'] = devbox.qmp_observe(directory, 'query-cpus-fast')
            cpus = [cpu['cpu-index'] for cpu in observed['qmp']['response']]
            reads = []
            def read(rva, size, section):
                if rva+size > module['ImageSize']:
                    raise Failure('kernel read outside loaded module extent', 76)
                for cpu in cpus:
                    destination = local / (section+'-cpu-'+str(cpu)+'.bin')
                    remote = '/state/'+destination.relative_to(directory).as_posix()
                    arguments = {'val': base+rva, 'size': size, 'filename': remote, 'cpu-index': cpu}
                    try:
                        response = devbox.qmp_observe(directory, 'memsave', arguments)
                        if destination.stat().st_size != size:
                            raise Failure('QMP kernel read incomplete', 76)
                        reads.append({'rva': rva, 'size': size, 'cpu': cpu, 'sha256': digest(destination), 'path': str(destination), 'qmp': response})
                        return destination.read_bytes()
                    except (Failure, OSError) as exc:
                        reads.append({'rva': rva, 'size': size, 'cpu': cpu, 'error': str(exc), 'path': str(destination)})
                raise Failure('resident kernel memory unavailable on every vCPU', 76)
            observed.update(mapped_kernel_identity(image_path.read_bytes(), base, read))
            observed['reads'] = reads
            current_boot = invoke(ws, name, "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')").stdout.strip()
            if current_boot != result['bootTime']:
                raise Failure('guest rebooted during kernel observation', 76)
            observed['bootTime'] = current_boot
            observed['expectedArtifact'] = None
            # A selected disk image and its matching mapping remain separate
            # from the package's requested hash and source provenance.
        except (Failure, OSError, ValueError) as exc:
            observed['error'] = str(exc)
    return observations


def registry(ws, name, mode, operation_id):
    retained = ws.state/'devboxes'/name/'stack-registry.json'
    if mode == 'show' and retained.is_file():
        result = json.loads(retained.read_text())
        result.update(observationKind='retained', exitCode=0)
        return result
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
    if mode != 'show' and host.get('loaded'):
        result['kernelImages'] = observe_kernel(ws, name, result, operation_id)
    package = result.get('requestedPackage')
    if package:
        required_sys = [f for f in package['files'] if f['path'].casefold() == 'payload/driver/helios_kmd_render.sys']
        kernels = [k for k in result.get('kernelImages', []) if PureWindowsPath(k['Path']).name.casefold() == 'helios_kmd_render.sys']
        if len(required_sys) == 1 and len(kernels) == 1:
            kernels[0]['expectedArtifact'] = {'sha256': required_sys[0]['sha256'].lower(), 'sources': package['source'],
                'manifestSha256': result['packageProvenance']['manifestSha256']}
            result['loadedKernelIdentity'] = kernels[0]['state'] if kernels[0].get('disk', {}).get('sha256') == required_sys[0]['sha256'].lower() else 'drift-selected-sys'
        graphics = result.get('graphics') or {}
        images = graphics.get('mappedImages', [])
        workloads = graphics.get('workloads', [])
        graphics_verified = (graphics.get('state') == 'passed' and graphics.get('sessionId', 0) > 0
            and graphics.get('manifestSha256') == result['packageProvenance']['manifestSha256']
            and graphics.get('bootTime') == result['bootTime'] and len(images) == 12 and len(workloads) == 13
            and all(i['mappedCode'] == 'mapped-code-matches' for i in images)
            and all(w['exitCode'] == 0 for w in workloads))
        host_manifest = json.loads(ws.resolve(devbox.load(ws, name)[1]['hostArtifact']['manifest']).read_text())
        mesa_artifacts = [a for a in package.get('artifacts', []) if a['target'].startswith('mesa-guest-')]
        result['protocolPairing'] = {'host': host_manifest['sources']['venus-protocol']['revision'],
            'guest': [a['sources']['venus-protocol']['revision'] for a in mesa_artifacts]}
        identity_keys = ('revision', 'snapshotSha256', 'narHash', 'diffSha256')
        protocol_host = {key: host_manifest['sources']['venus-protocol'].get(key) for key in identity_keys}
        protocol_guests = [{key: artifact['sources']['venus-protocol'].get(key) for key in identity_keys}
                           for artifact in mesa_artifacts]
        result['protocolPairing'].update(hostIdentity=protocol_host, guestIdentities=protocol_guests)
        paired = (len(mesa_artifacts) == 2 and protocol_host['diffSha256'] is None
                  and bool(protocol_host['snapshotSha256'] and protocol_host['narHash'])
                  and all(identity == protocol_host for identity in protocol_guests))
        result['loadedVerified'] = bool(result.get('installedVerified') and result.get('state') != 'drift' and host.get('loaded')
            and result['loadedKernelIdentity'] == 'mapped-code-matches' and graphics_verified and paired)
        result['loadedEvidenceKind'] = 'resident-kernel-and-recorded-desktop-mappings' if result['loadedVerified'] else 'incomplete'
    result["operationId"] = operation_id
    result["task"] = {key: value for key, value in observation.items() if key not in {"logs"}}
    result["exitCode"] = observation.get("exitCode", 0)
    if mode == 'verify':
        result['exitCode'] = 0 if result.get('loadedVerified') else 76
        result['state'] = 'verified' if result.get('loadedVerified') else 'incomplete' if result.get('state') != 'drift' else 'drift'
    if result["exitCode"]:
        result["verificationError"] = "Full selected stack and kernel loaded-image evidence are still required"
    write_json(local, result)
    write_json(retained, result)
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
    required_scripts = {"install-helios.ps1", "uninstall-helios.ps1", "verify-helios.ps1", "helios-packagecommon.ps1"}
    if not fixture and not required_scripts.issubset(seen):
        raise Failure("package must manifest the original installer scripts beside manifest.json", 2,
                      missing=sorted(required_scripts-seen))
    if not fixture:
        required = {'payload/driver/'+name for name in ['helios_kmd_render.sys','helios_kmd_render.inf','helios_kmd_render.cat',
                    'helios_umd.dll','helios_umd12.dll','helios_umd32.dll','helios_umd12_32.dll']}
        required.update('payload/mesa/'+architecture+image for architecture in ['', 'x86/']
                        for image in ['vulkan_virtio.dll','libgallium_wgl.dll'])
        required.update(['payload/opencl/clvk.dll','payload/loaders/vulkan-1.dll',
                         'payload/loaders/x86/vulkan-1.dll','payload/loaders/opencl.dll'])
        certificate = windows_relative(manifest['signing'].get('certificate', '')).casefold()
        required.add(certificate)
        if not required.issubset(seen):
            raise Failure('complete native/WoW64 stack and signing certificate are required before installation', 2,
                          missing=sorted(required-seen))
    remote = ROOT + "\\jobs\\" + operation_id
    spec = {"schemaVersion": 1, "kind": "fixture" if fixture else "helios", "operationId": operation_id,
            "archive": remote + "\\bundle.zip", "archiveSha256": digest(archive), "archiveSize": archive.stat().st_size,
            "manifestSha256": digest(manifest_path), "requestedManifest": manifest, "failureAfterCopy": failure_after_copy}
    write_json(local / "install.json", spec)
    submit(ws, name, operation_id, Path(os.environ["WB_DEVBOX_PAYLOADS"]) / "Install.ps1", "install",
           [remote + "\\install.json"], metadata={"kind": "install", "manifestSha256": spec["manifestSha256"],
             "requested": manifest, "built": {"files": manifest["files"]}}, inputs={"install.json": local / "install.json", "bundle.zip": archive})
    result = wait(ws, name, operation_id, allow_reboot=True)
    result["transactionId"] = operation_id
    result["installedVerified"] = False
    result["loadedVerified"] = False
    return result
