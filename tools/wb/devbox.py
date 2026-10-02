"""Shared devbox operations. Nix owns tools, the container and guest payloads."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

from . import builds
from .common import Failure, atomic_write, digest, locked, run, write_json


def file_hash(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def bounded(argv, timeout=15):
    try:
        return subprocess.run([str(v) for v in argv], text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(argv, 3, "", str(exc))


def settings(ws):
    config = ws.config.get("devbox", {})
    allowed = {"isoPath", "isoSha256", "edition", "containerRuntime", "runtimeCommand", "renderNode",
               "sshPort", "viewerPort", "viewer", "hostManifest", "cpus", "memoryMiB", "diskGiB",
               "guestUsername", "guestComputerName", "guestShare", "guestMirror", "guestBuildRoot", "rdpPort"}
    if not isinstance(config, dict) or set(config) - allowed:
        raise Failure("unknown devbox configuration field", 2)
    for key, value in {"guestUsername": "wbdev", "guestComputerName": "WB-DEVBOX", "guestShare": "Z:\\",
                       "guestMirror": "C:\\WinBoatDev\\src", "guestBuildRoot": "C:\\WinBoatDev\\build"}.items():
        if config.get(key, value) != value:
            raise Failure(key + " is a defined Windows guest contract", 2)
    if config.get("viewer", "auto") not in {"auto", "tigervnc"}:
        raise Failure("the implemented attachable viewer is tigervnc; standalone QEMU SDL cannot hot-attach", 2)
    return config


def name_check(name):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", name):
        raise Failure("devbox name must be 1-32 lowercase letters, digits or hyphens", 2)
    return name


def location(ws, name):
    path = ws.state / "devboxes" / name_check(name)
    if path.is_symlink() or path.resolve() != path:
        raise Failure("devbox state path contains an escaping symlink", 2)
    return path


def owner(ws, create=False):
    path = ws.state / "devboxes/owner.json"
    if not path.exists():
        if not create:
            raise Failure("no devbox owner identity; create a devbox first", 2)
        write_json(path, {"schemaVersion": 1, "identity": uuid.uuid4().hex})
    data = json.loads(path.read_text())
    if data.get("schemaVersion") != 1 or not re.fullmatch(r"[0-9a-f]{32}", data.get("identity", "")):
        raise Failure("unsupported devbox owner record", 2)
    return data["identity"]


def load(ws, name):
    directory = location(ws, name)
    data = json.loads((directory / "devbox.json").read_text())
    if data.get("schemaVersion") != 1 or data.get("name") != name or data.get("owner") != owner(ws):
        raise Failure("devbox record does not belong to this workspace", 2)
    if not re.fullmatch(r"[0-9a-f]{32}", data.get("identity", "")):
        raise Failure("invalid devbox identity", 2)
    return directory, data


def runtime_candidates(ws):
    config = settings(ws)
    choice = config.get("containerRuntime", "auto")
    if choice not in {"auto", "docker", "podman"}:
        raise Failure("containerRuntime must be auto, docker or podman", 2)
    override = config.get("runtimeCommand")
    if override is not None:
        if (choice == "auto" or not isinstance(override, list) or not override
                or any(not isinstance(v, str) or not v or "\n" in v or "\0" in v for v in override)):
            raise Failure("runtimeCommand requires an explicit runtime and a nonempty argument array", 2)
        return [(choice, override)]
    commands = {"docker": [os.environ["WB_DOCKER"]],
                "podman": [os.environ["WB_PODMAN"], "--root", str(ws.state / "container/storage"),
                           "--runroot", str(ws.state / "container/run"), "--storage-driver", "vfs"]}
    return [(key, commands[key]) for key in ([choice] if choice != "auto" else ["docker", "podman"])]


def runtime(ws):
    diagnostics = []
    for kind, command in runtime_candidates(ws):
        # Docker accepts '{{json .}}'; Podman accepts the literal 'json'.
        result = bounded(command + ["info", "--format", "{{json .}}" if kind == "docker" else "json"])
        if not result.returncode:
            try:
                info = json.loads(result.stdout)
            except ValueError:
                diagnostics.append({"runtime": kind, "error": "runtime returned invalid info JSON"})
                continue
            if kind == "docker" and not info.get("ServerVersion"):
                continue
            return {"kind": kind, "command": command, "info": info}
        diagnostics.append({"runtime": kind, "error": result.stderr.strip() or result.stdout.strip()})
    raise Failure("no usable container runtime; configure access to Docker or rootless Podman, or an explicit devbox.runtimeCommand",
                  3, runtimes=diagnostics)


def capabilities(ws, probe_runtime=True):
    config = settings(ws)
    nodes = sorted(Path("/dev/dri").glob("renderD*"))
    selected = config.get("renderNode", "auto")
    observations = [{"path": str(path), "accessible": os.access(path, os.R_OK | os.W_OK),
                     "sysfsDevice": str((Path("/sys/class/drm") / path.name / "device").resolve())}
                    for path in nodes]
    if selected != "auto":
        path = Path(selected)
        if path not in nodes:
            raise Failure("renderNode must be an existing DRM render node", 2)
        usable = [str(path)] if os.access(path, os.R_OK | os.W_OK) else []
    else:
        usable = [item["path"] for item in observations if item["accessible"]]
    result = {"kvm": {"accessible": os.access("/dev/kvm", os.R_OK | os.W_OK),
                      "remedy": "provide read/write KVM access; local devboxes require Linux KVM"},
              "renderNodes": observations, "renderNode": usable[0] if len(usable) == 1 else None,
              "renderRemedy": "select devbox.renderNode explicitly when multiple accessible GPUs exist",
              "display": {"available": bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("DISPLAY")),
                          "wayland": os.environ.get("WAYLAND_DISPLAY"), "x11": os.environ.get("DISPLAY")}}
    if probe_runtime:
        try:
            found = runtime(ws)
            result["runtime"] = {"available": True, "kind": found["kind"], "command": found["command"]}
        except Failure as exc:
            result["runtime"] = {"available": False, "error": str(exc), **exc.details}
    return result


def host_artifact(ws, path):
    if not path:
        raise Failure("select an exact host-stack --manifest or devbox.hostManifest; latest-run selection is forbidden", 2)
    path = ws.resolve(path)
    verified = builds.verify(path)
    manifest = json.loads(path.read_text())
    if manifest.get("target") != "host-stack" or manifest.get("abi") != "linux-x86_64":
        raise Failure("devbox requires a built Linux x64 host-stack manifest", 2)
    if manifest["toolchain"]["lockSha256"] != digest(ws.root / "devenv.lock"):
        raise Failure("host artifact uses a different Nix lock", 2)
    output = Path(manifest["outputs"][0]["outputs"]["out"])
    if not re.fullmatch(r"/nix/store/[a-z0-9]{32}-[^/]+", str(output)):
        raise Failure("host-stack output must be a retained immutable store path", 2)
    actual = json.loads(run([os.environ["WB_NIX"], "path-info", "--recursive", "--json", output]).stdout)
    expected = manifest.get("closure")
    def table(closure):
        if isinstance(closure, list):
            return {entry["path"]: entry for entry in closure}
        return closure
    expected, actual = table(expected), table(actual)
    if not isinstance(expected, dict) or set(expected) != set(actual):
        raise Failure("retained store closure differs from host artifact manifest", 2)
    for key in expected:
        if any(expected[key].get(field) != actual[key].get(field) for field in ["narHash", "narSize", "references"]):
            raise Failure("store closure identity differs: " + key, 2)
    images = {}
    for entry in manifest["files"]:
        image = path.parent / "files" / entry["path"]
        if image.is_file() and "sha256" in entry:
            images[str(image.resolve())] = entry["sha256"]
    # Retain the report supplied by the actual Stage 2 recipe, regardless of name.
    reports = list(output.glob("share/**/host-smoke*.json"))
    if not reports:
        reports = list(output.glob("share/**/host-stack-smoke*.json"))
    if not reports or not manifest.get("licenses") or not manifest.get("symbols"):
        raise Failure("host-stack lacks smoke, license or symbol evidence", 2)
    return {"manifest": str(path), "manifestSha256": verified["manifestSha256"], "output": str(output),
            "closurePaths": len(expected), "expectedImages": images,
            "smoke": [str(p) for p in reports], "artifactId": manifest["artifactId"]}


def media(ws, iso, expected_hash=None, index=None, edition=None, locale="en-US"):
    path = ws.resolve(iso)
    if not path.is_file() or path.suffix.lower() != ".iso":
        raise Failure("Windows media must be an existing user-supplied ISO", 2)
    if not re.fullmatch(r"[a-z]{2}-[A-Z]{2}", locale):
        raise Failure("locale must be a Windows locale such as en-US", 2)
    observed_hash = file_hash(path)
    if expected_hash and expected_hash != observed_hash:
        raise Failure("Windows ISO SHA-256 differs from the requested identity", 2)
    cache = ws.state / "media" / observed_hash
    with locked(ws.state / "locks" / ("media-" + observed_hash + ".lock")):
        cache.mkdir(parents=True, exist_ok=True)
        metadata = cache / "images.xml"
        if not metadata.exists():
            extracted = cache / "install.wim"
            extracted.unlink(missing_ok=True)
            listing = run([os.environ["WB_7ZIP"], "l", "-slt", path])
            sources = [line[7:] for line in listing.stdout.splitlines()
                       if line.startswith("Path = ") and line[7:].lower() in {"sources/install.wim", "sources/install.esd"}]
            if len(sources) != 1:
                raise Failure("ISO must contain exactly one sources/install.wim or install.esd", 2)
            run([os.environ["WB_7ZIP"], "e", "-y", "-o" + str(cache), path, sources[0]])
            source_file = cache / Path(sources[0]).name
            if source_file != extracted:
                source_file.rename(extracted)
            try:
                run([os.environ["WB_WIMLIB"], "info", extracted, "--extract-xml=" + str(metadata)])
                write_json(cache / "metadata.json", {"schemaVersion": 1, "isoSha256": observed_hash, "xmlSha256": digest(metadata)})
            finally:
                extracted.unlink(missing_ok=True)
        cached = json.loads((cache / "metadata.json").read_text()) if (cache / "metadata.json").exists() else None
        if cached is None:
            # Migrate the metadata-only cache from the initial Stage 3 probe by
            # requiring a new extraction; never invent cached provenance.
            metadata.unlink()
            raise Failure("unverified media metadata cache removed; retry the media command", 3)
        if cached.get("isoSha256") != observed_hash or cached.get("xmlSha256") != digest(metadata):
            raise Failure("cached Windows media metadata has drifted", 2)
        tree = ET.fromstring(metadata.read_bytes())
        images = [{"index": int(image.attrib["INDEX"]), "name": image.findtext("NAME"),
                   "edition": image.findtext("WINDOWS/EDITIONID"), "architecture": image.findtext("WINDOWS/ARCH"),
                   "languages": [item.text for item in image.findall("WINDOWS/LANGUAGES/LANGUAGE")],
                   "build": image.findtext("WINDOWS/VERSION/BUILD")} for image in tree.findall("IMAGE")]
    matches = [item for item in images if (item["index"] == index if index is not None else
               item["edition"] in ({edition} if edition else {"Enterprise", "EnterpriseS"}))]
    if len(matches) != 1:
        raise Failure("choose an explicit compatible --index and --edition from ISO image metadata", 2, images=images)
    selected = matches[0]
    if selected["architecture"] != "9" or locale.lower() not in [v.lower() for v in selected["languages"]]:
        raise Failure("image is not amd64 or lacks the selected locale", 2, image=selected)
    if edition and edition != selected["edition"]:
        raise Failure("requested edition and ISO index disagree", 2)
    if selected["edition"] not in {"Enterprise", "EnterpriseS"} and (index is None or not edition):
        raise Failure("non-Enterprise media requires explicit --index and --edition", 2)
    return {"path": str(path), "sha256": observed_hash, "size": path.stat().st_size,
            "image": selected, "locale": locale, "images": images}


def provision_lock(ws):
    path = ws.root / "config/provision.lock.json"
    data = json.loads(path.read_text())
    if data.get("schemaVersion") != 1:
        raise Failure("unsupported provisioning lock schema", 2)
    unresolved = [item["id"] for item in data["tools"] if item.get("status") != "locked"]
    for item in data["tools"]:
        if item.get("status") == "locked":
            for payload in item.get("payloads", []):
                if not re.fullmatch(r"[0-9a-f]{64}", payload.get("sha256", "")):
                    raise Failure("invalid provisioning payload hash: " + item["id"], 2)
    return {"sha256": digest(path), "data": data, "unresolved": unresolved}


def answer_xml(password, index, locale):
    namespace = "urn:schemas-microsoft-com:unattend"
    ET.register_namespace("", namespace)
    ET.register_namespace("wcm", "http://schemas.microsoft.com/WMIConfig/2002/State")
    root = ET.Element("{" + namespace + "}unattend")
    def child(parent, tag, value=None, **attributes):
        node = ET.SubElement(parent, "{" + namespace + "}" + tag, attributes)
        if value is not None:
            node.text = str(value)
        return node
    def component(pass_name, name):
        settings = next((item for item in root if item.get("pass") == pass_name), None)
        if settings is None:
            settings = child(root, "settings", **{"pass": pass_name})
        return child(settings, "component", name=name, processorArchitecture="amd64",
                     publicKeyToken="31bf3856ad364e35", language="neutral", versionScope="nonSxS")
    international = component("windowsPE", "Microsoft-Windows-International-Core-WinPE")
    child(child(international, "SetupUILanguage"), "UILanguage", locale)
    for key in ["InputLocale", "SystemLocale", "UILanguage", "UserLocale"]:
        child(international, key, locale)
    setup = component("windowsPE", "Microsoft-Windows-Setup")
    disk = child(child(setup, "DiskConfiguration"), "Disk", DiskID="0",
                 **{"{http://schemas.microsoft.com/WMIConfig/2002/State}action": "add"})
    # DiskID is an element in the unattended schema, not an attribute.
    disk.attrib.pop("DiskID")
    child(disk, "DiskID", 0); child(disk, "WillWipeDisk", "true")
    partitions = child(disk, "CreatePartitions")
    for order, kind, size in [(1, "EFI", 260), (2, "MSR", 16), (3, "Primary", None)]:
        partition = child(partitions, "CreatePartition", **{"{http://schemas.microsoft.com/WMIConfig/2002/State}action": "add"})
        child(partition, "Order", order); child(partition, "Type", kind)
        child(partition, "Size" if size else "Extend", size or "true")
    modifications = child(disk, "ModifyPartitions")
    for order, (partition_id, format_, letter) in enumerate([(1, "FAT32", None), (3, "NTFS", "C")], 1):
        partition = child(modifications, "ModifyPartition", **{"{http://schemas.microsoft.com/WMIConfig/2002/State}action": "add"})
        child(partition, "Order", order); child(partition, "PartitionID", partition_id); child(partition, "Format", format_)
        if letter:
            child(partition, "Letter", letter)
    image = child(child(setup, "ImageInstall"), "OSImage")
    metadata = child(child(image, "InstallFrom"), "MetaData", **{"{http://schemas.microsoft.com/WMIConfig/2002/State}action": "add"})
    child(metadata, "Key", "/IMAGE/INDEX"); child(metadata, "Value", index)
    install_to = child(image, "InstallTo")
    child(install_to, "DiskID", 0); child(install_to, "PartitionID", 3); child(image, "WillShowUI", "OnError")
    user_data = child(setup, "UserData")
    child(user_data, "AcceptEula", "true"); child(user_data, "FullName", "wbdev"); child(user_data, "Organization", "WinBoat")
    specialize = component("specialize", "Microsoft-Windows-Shell-Setup")
    child(specialize, "ComputerName", "WB-DEVBOX")
    international = component("oobeSystem", "Microsoft-Windows-International-Core")
    for key in ["InputLocale", "SystemLocale", "UILanguage", "UserLocale"]:
        child(international, key, locale)
    shell = component("oobeSystem", "Microsoft-Windows-Shell-Setup")
    oobe = child(shell, "OOBE")
    for key in ["HideEULAPage", "HideOnlineAccountScreens", "HideWirelessSetupInOOBE", "HideLocalAccountScreen"]:
        child(oobe, key, "true")
    child(oobe, "ProtectYourPC", 3)
    account = child(child(child(shell, "UserAccounts"), "LocalAccounts"), "LocalAccount",
                    **{"{http://schemas.microsoft.com/WMIConfig/2002/State}action": "add"})
    child(account, "Name", "wbdev"); child(account, "Group", "Administrators")
    secret = child(account, "Password"); child(secret, "Value", password); child(secret, "PlainText", "true")
    login = child(shell, "AutoLogon")
    for key, value in [("Username", "wbdev"), ("Enabled", "true"), ("LogonCount", 1)]:
        child(login, key, value)
    secret = child(login, "Password"); child(secret, "Value", password); child(secret, "PlainText", "true")
    first = child(child(shell, "FirstLogonCommands"), "SynchronousCommand",
                  **{"{http://schemas.microsoft.com/WMIConfig/2002/State}action": "add"})
    child(first, "Order", 1)
    child(first, "CommandLine", 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Volume | Where-Object FileSystemLabel -eq WBANSWER | ForEach-Object { & ($_.DriveLetter + \':\\Bootstrap.ps1\') }"')
    return ET.tostring(root, encoding="utf-8", xml_declaration=True).decode()


def allocate_ports(ws, directory, config):
    used = set()
    for path in (ws.state / "devboxes").glob("*/devbox.json"):
        if path.parent != directory:
            used.update(json.loads(path.read_text()).get("ports", {}).values())
    result = {}
    sockets = []
    try:
        for key, setting in [("ssh", "sshPort"), ("viewer", "viewerPort")]:
            value = config.get(setting, "auto")
            if value != "auto" and (type(value) is not int or not 1024 <= value <= 65535):
                raise Failure(setting + " must be auto or a port from 1024 to 65535", 2)
            for _ in range(100):
                sock = socket.socket()
                try:
                    sock.bind(("127.0.0.1", 0 if value == "auto" else value))
                except OSError as exc:
                    sock.close(); raise Failure("requested devbox port is unavailable: " + str(exc), 3) from exc
                port = sock.getsockname()[1]
                if port not in used:
                    sockets.append(sock); result[key] = port; used.add(port); break
                sock.close()
                if value != "auto":
                    raise Failure("requested port belongs to another devbox", 2)
            else:
                raise Failure("could not reserve a distinct devbox port", 3)
    finally:
        for sock in sockets:
            sock.close()
    return result


def create(ws, args, operation_id):
    config = settings(ws)
    iso = args.iso or config.get("isoPath")
    if not iso:
        raise Failure("provide --iso <user-supplied Windows ISO>", 2)
    artifact = host_artifact(ws, args.manifest or config.get("hostManifest"))
    selected = media(ws, iso, args.iso_sha256 or config.get("isoSha256"), args.index, args.edition or config.get("edition"), args.locale)
    provision = provision_lock(ws)
    directory = location(ws, args.name)
    disk_gib = config.get("diskGiB", 128)
    cpus, memory = config.get("cpus", 4), config.get("memoryMiB", 8192)
    if any(type(value) is not int or value < lower or value > upper for value, lower, upper in
           [(disk_gib, 64, 2048), (cpus, 2, 128), (memory, 4096, 524288)]):
        raise Failure("invalid devbox disk/cpu/memory limits", 2)
    with locked(ws.state / "locks/devboxes.lock"):
        owner_id = owner(ws, create=True)
        if (directory / "devbox.json").exists():
            _, record = load(ws, args.name)
            if (record["media"]["sha256"] != selected["sha256"] or record["media"]["image"] != selected["image"]
                    or record["media"]["locale"] != selected["locale"]
                    or record["hostArtifact"]["manifestSha256"] != artifact["manifestSha256"]):
                raise Failure("devbox exists with different media/artifact; use a new name or guarded destroy", 2)
            if record["provisioning"]["phase"] != "initializing":
                if args.start:
                    return up(ws, args.name, operation_id)
                return {"state": "prepared", "name": args.name, "resumed": True,
                        "provisioning": record["provisioning"], "externalStep": "wb devbox up --name " + args.name}
            if record["provisioning"]["lockSha256"] != provision["sha256"]:
                raise Failure("provision lock changed during initialization; use a new devbox", 2)
        else:
            if directory.exists() and any(directory.iterdir()):
                raise Failure("unrecognized existing devbox state; never overwrite its disks", 2)
            record = {"schemaVersion": 1, "name": args.name, "identity": uuid.uuid4().hex, "owner": owner_id,
                      "media": selected, "hostArtifact": artifact, "ports": allocate_ports(ws, directory, config),
                      "cpus": cpus, "memoryMiB": memory, "diskGiB": disk_gib,
                      "created": time.time(), "operationId": operation_id, "image": None,
                      "initialBootPending": True,
                      "provisioning": {"phase": "initializing", "installed": False, "verified": False,
                                       "lockSha256": provision["sha256"], "unresolvedInputs": provision["unresolved"]}}
            write_json(directory / "devbox.json", record)
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        directory.chmod(0o700)
        secrets_dir = directory / "secrets"
        secrets_dir.mkdir(mode=0o700, exist_ok=True)
        if not (secrets_dir / "password").exists():
            atomic_write(secrets_dir / "password", secrets.token_urlsafe(30) + "\n", 0o600)
        password = (secrets_dir / "password").read_text().strip()
        if not (secrets_dir / "ssh").exists():
            run([os.environ["WB_SSH_KEYGEN"], "-q", "-t", "ed25519", "-N", "", "-f", secrets_dir / "ssh", "-C", "winboat-devbox"])
        payload = directory / "answer"
        payload.mkdir(mode=0o700, exist_ok=True)
        if not (payload / "ssh_host_ed25519_key").exists():
            run([os.environ["WB_SSH_KEYGEN"], "-q", "-t", "ed25519", "-N", "", "-f", payload / "ssh_host_ed25519_key", "-C", "WB-DEVBOX"])
        atomic_write(payload / "Autounattend.xml", answer_xml(password, selected["image"]["index"], selected["locale"]))
        for path in Path(os.environ["WB_DEVBOX_PAYLOADS"]).iterdir():
            shutil.copyfile(path, payload / path.name)
        shutil.copyfile(secrets_dir / "ssh.pub", payload / "authorized_keys")
        write_json(payload / "provision.lock.json", provision["data"])
        atomic_write(payload / "share-password", password)
        run([os.environ["WB_XORRISO"], "-as", "mkisofs", "-J", "-r", "-V", "WBANSWER", "-o", directory / "answer.partial.iso", payload])
        (directory / "answer.partial.iso").replace(directory / "answer.iso")
        stack = Path(artifact["output"])
        if not (directory / "disk.qcow2").exists():
            temporary = directory / "disk.partial.qcow2"
            temporary.unlink(missing_ok=True)
            run([stack / "bin/qemu-img", "create", "-f", "qcow2", temporary, str(record["diskGiB"]) + "G"])
            temporary.replace(directory / "disk.qcow2")
        if not (directory / "nvram.fd").exists():
            shutil.copyfile(stack / "share/qemu/edk2-i386-vars.fd", directory / "nvram.fd")
        record["provisioning"]["phase"] = "prepared"
        host_key = (payload / "ssh_host_ed25519_key.pub").read_text().split()
        atomic_write(directory / "known_hosts", f"[127.0.0.1]:{record['ports']['ssh']} {host_key[0]} {host_key[1]}\n")
        write_json(directory / "devbox.json", record)
        ws.journal(operation_id, {"kind": "devbox-create", "state": "prepared", "name": args.name,
                                  "mediaSha256": selected["sha256"], "manifestSha256": artifact["manifestSha256"],
                                  "provisioning": record["provisioning"]})
    if args.start:
        return up(ws, args.name, operation_id)
    return {"state": "prepared", "name": args.name, "ports": record["ports"],
            "media": {key: value for key, value in selected.items() if key != "path"},
            "provisioning": record["provisioning"], "externalStep": "wb devbox up --name " + args.name}


def container_name(record):
    return "wbdev-" + record["identity"]


def inspect(rt, record):
    result = run(rt["command"] + ["container", "inspect", container_name(record)], check=False)
    if result.returncode:
        # Distinguish a missing container from runtime/daemon failure.
        info = bounded(rt["command"] + ["info"])
        if info.returncode:
            raise Failure("container runtime disconnected during inspection", 3, error=info.stderr)
        if not any(value in (result.stderr + result.stdout).lower() for value in ["no such", "not found", "does not exist"]):
            raise Failure("container inspection failed", 3, error=result.stderr)
        return None
    data = json.loads(result.stdout)[0]
    labels = data.get("Config", {}).get("Labels", {})
    if labels.get("org.winboat.owner") != record["owner"] or labels.get("org.winboat.identity") != record["identity"]:
        raise Failure("container ownership labels differ; refusing to control it", 2)
    if record.get("image") and data.get("Image") != record["image"]["id"]:
        raise Failure("container image differs from retained devbox image", 2)
    return data


def build_image(ws, directory, record, rt):
    spec = {"schemaVersion": 1, "system": os.environ["WB_SYSTEM"], "hostStack": record["hostArtifact"]["output"],
            "identity": record["identity"], "manifestSha256": record["hostArtifact"]["manifestSha256"],
            "lockSha256": digest(ws.root / "devenv.lock")}
    write_json(directory / "image-spec.json", spec)
    command = [os.environ["WB_NIX"], "build", "--json", "--out-link", directory / "container-image",
               "--file", os.environ["WB_DEVBOX_EXPRESSION"], "--argstr", "nixpkgsPath", os.environ["WB_NIXPKGS"],
               "--argstr", "specification", directory / "image-spec.json"]
    with (directory / "image-build.log").open("a") as log:
        result = subprocess.run([str(v) for v in command], stdout=subprocess.PIPE, stderr=log, text=True)
    if result.returncode:
        raise Failure("Nix devbox image build failed", result.returncode, log=str(directory / "image-build.log"))
    output = json.loads(result.stdout)[0]
    archive = Path(output["outputs"]["out"])
    run(rt["command"] + ["load", *(["--signature-policy", os.environ["WB_CONTAINER_POLICY"]] if rt["kind"] == "podman" else []), "--input", archive])
    tag = "winboat-devbox:" + record["identity"]
    data = json.loads(run(rt["command"] + ["image", "inspect", tag]).stdout)[0]
    image_id = data.get("Id") or data.get("ID")
    if not image_id:
        raise Failure("runtime did not report an immutable image identity", 3)
    labels = data.get("Config", {}).get("Labels", {})
    if labels.get("org.winboat.manifest-sha256") != spec["manifestSha256"]:
        raise Failure("imported image manifest label differs", 3)
    return {"id": image_id, "archiveSha256": file_hash(archive), "output": str(archive),
            "derivation": output["drvPath"], "lockSha256": spec["lockSha256"],
            "hostStack": spec["hostStack"], "manifestSha256": spec["manifestSha256"]}


def up(ws, name, operation_id, rebuild_image=False):
    with locked(ws.state / "locks" / ("devbox-" + name_check(name) + ".lock")):
        directory, record = load(ws, name)
        rt = runtime(ws)
        existing = inspect(rt, record)
        if existing and existing["State"].get("Running"):
            if rebuild_image:
                raise Failure("stop the devbox before rebuilding its container image", 2)
            return status(ws, name, rt=rt)
        observed = capabilities(ws, probe_runtime=False)
        if not observed["kvm"]["accessible"] or not observed["renderNode"]:
            raise Failure("KVM or a selected accessible render node is missing", 3, capabilities=observed)
        artifact = host_artifact(ws, record["hostArtifact"]["manifest"])
        if artifact["manifestSha256"] != record["hostArtifact"]["manifestSha256"]:
            raise Failure("selected host artifact changed after creation", 2)
        if file_hash(record["media"]["path"]) != record["media"]["sha256"]:
            raise Failure("Windows media changed after creation", 2)
        if not record["image"] or rebuild_image:
            if record["image"]:
                previous = record["image"]
                record.setdefault("previousImages", []).append(previous)
                retained = directory / "images" / previous["archiveSha256"]
                retained.parent.mkdir(exist_ok=True)
                if not retained.exists():
                    run([os.environ["WB_NIX"], "build", "--out-link", retained, previous["output"]])
            record["image"] = build_image(ws, directory, record, rt)
            write_json(directory / "devbox.json", record)
        if record["image"]["lockSha256"] != digest(ws.root / "devenv.lock"):
            raise Failure("devbox image lock differs; create a new devbox", 2)
        if existing:
            run(rt["command"] + ["rm", container_name(record)])
        write_json(directory / "launch.json", {"cpus": record["cpus"], "memoryMiB": record["memoryMiB"],
                   "renderNode": observed["renderNode"], "attachMedia": not record["provisioning"]["verified"],
                   "initialBoot": record.get("initialBootPending", False),
                   "expectedImages": artifact["expectedImages"]})
        (directory / "host-observation.json").unlink(missing_ok=True)
        command = rt["command"] + ["run", "--pull=never", "--detach", "--name", container_name(record),
                  "--label", "org.winboat.owner=" + record["owner"], "--label", "org.winboat.identity=" + record["identity"],
                  "--device", "/dev/kvm", "--device", observed["renderNode"],
                  "--publish", f"127.0.0.1:{record['ports']['ssh']}:22",
                  "--publish", f"127.0.0.1:{record['ports']['viewer']}:5900",
                  "--mount", f"type=bind,source={directory},destination=/state",
                  "--mount", f"type=bind,source={ws.root},destination=/workspace,readonly",
                  "--mount", f"type=bind,source={record['media']['path']},destination=/media/windows.iso,readonly",
                  record["image"]["id"]]
        private_share = directory / "empty-share"
        private_share.mkdir(exist_ok=True)
        if (ws.root / "docs/user").exists():
            command[-1:-1] = ["--mount", f"type=bind,source={private_share},destination=/workspace/docs/user,readonly"]
        if rt["kind"] == "podman":
            command[command.index("--detach"):command.index("--detach")] = ["--group-add", "keep-groups"]
        # Bind mount comma syntax cannot represent comma-containing host paths.
        if any("," in str(path) for path in [directory, ws.root, record["media"]["path"]]):
            raise Failure("container mount paths containing commas are unsupported", 2)
        run(command)
        record["provisioning"]["phase"] = "booting"
        write_json(directory / "devbox.json", record)
        for _ in range(300):
            observation = directory / "host-observation.json"
            if observation.exists():
                data = json.loads(observation.read_text())
                if data["state"] == "running" and data.get("loaded"):
                    record["initialBootPending"] = False
                    write_json(directory / "devbox.json", record)
                    ws.journal(operation_id, {"kind": "devbox-up", "state": "running", "name": name,
                                              "image": record["image"], "hostObservation": str(observation)})
                    return status(ws, name, rt=rt)
                if data["state"] == "failed":
                    raise Failure("container QEMU identity/startup check failed", 3, observation=data,
                                  log=str(directory / "qemu.log"))
            current = inspect(rt, record)
            if not current or not current["State"].get("Running"):
                raise Failure("devbox container exited before QEMU identity verification", 3,
                              log=str(directory / "qemu.log"), container=container_name(record))
            time.sleep(0.1)
        raise Failure("devbox QEMU startup timed out; inspect logs before retrying", 3, name=name)


def status(ws, name, rt=None):
    directory, record = load(ws, name)
    result = {"name": name, "state": "prepared", "ports": record["ports"], "image": record["image"],
              "provisioning": record["provisioning"], "desiredHostArtifact": record["hostArtifact"]["manifestSha256"],
              "hostObservation": None, "guestObservation": None, "loaded": False}
    try:
        rt = rt or runtime(ws)
        data = inspect(rt, record)
        result["state"] = "running" if data and data["State"].get("Running") else "stopped" if data else "prepared"
        if data:
            result["container"] = {"id": data["Id"], "state": data["State"], "image": data["Image"]}
    except Failure as exc:
        if exc.code != 3:
            raise
        result["state"] = "runtime-unavailable"
        result["runtimeError"] = {"message": str(exc), **exc.details}
    for filename, key in [("host-observation.json", "hostObservation"), ("guest-observation.json", "guestObservation")]:
        path = directory / filename
        if path.exists():
            result[key] = json.loads(path.read_text())
    result["loaded"] = result["state"] == "running" and bool((result["hostObservation"] or {}).get("loaded"))
    return result


def down(ws, name, operation_id, force=False):
    with locked(ws.state / "locks" / ("devbox-" + name_check(name) + ".lock")):
        directory, record = load(ws, name)
        rt = runtime(ws)
        data = inspect(rt, record)
        if data and data["State"].get("Running"):
            if force:
                run(rt["command"] + ["stop", "--time", "15", container_name(record)])
                ws.journal(operation_id, {"kind": "devbox-down", "state": "stopped", "name": name, "cleanShutdown": False})
                return {"name": name, "state": "stopped", "loaded": False, "cleanShutdown": False}
            # First request guest shutdown through QMP. Stopping a container alone
            # terminates QEMU and is not a clean Windows shutdown.
            qmp = directory / "qmp.sock"
            try:
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(5); client.connect(str(qmp))
                    with client.makefile("rwb") as stream:
                        stream.readline()
                        for command in ["qmp_capabilities", "system_powerdown"]:
                            stream.write(json.dumps({"execute": command}).encode() + b"\n"); stream.flush()
                            while True:
                                reply = json.loads(stream.readline())
                                if "error" in reply:
                                    raise Failure("QMP refused guest shutdown", 3, response=reply)
                                if "return" in reply:
                                    break
            except OSError as exc:
                raise Failure("QMP unavailable; refusing an unclean shutdown", 3, error=str(exc)) from exc
            for _ in range(300):
                current = inspect(rt, record)
                if not current or not current["State"].get("Running"):
                    break
                time.sleep(0.1)
            else:
                raise Failure("guest did not shut down; VM preserved running", 3, name=name)
        ws.journal(operation_id, {"kind": "devbox-down", "state": "stopped", "name": name})
        return {"name": name, "state": "stopped", "loaded": False}


def destroy(ws, name, confirmation, operation_id):
    with locked(ws.state / "locks/devboxes.lock"), locked(ws.state / "locks" / ("devbox-" + name_check(name) + ".lock")):
        directory, record = load(ws, name)
        if confirmation != record["identity"]:
            raise Failure("destroy requires --confirm " + record["identity"] + "; this permanently deletes this devbox's disks and keys", 2)
        rt = runtime(ws)
        data = inspect(rt, record)
        if data and data["State"].get("Running"):
            raise Failure("stop this devbox before destroying it", 2)
        if data:
            run(rt["command"] + ["rm", container_name(record)])
        if directory.is_symlink() or directory.resolve() != location(ws, name):
            raise Failure("devbox deletion boundary changed", 2)
        shutil.rmtree(directory)
        ws.journal(operation_id, {"kind": "devbox-destroy", "name": name, "state": "destroyed", "identity": confirmation})
        return {"name": name, "state": "destroyed"}


def ssh_command(directory, record):
    return [os.environ["WB_SSH"], "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(directory / "known_hosts"),
            "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=10", "-i", directory / "secrets/ssh",
            "-p", str(record["ports"]["ssh"]), "wbdev@127.0.0.1"]


def guest_status(ws, name, operation_id):
    directory, record = load(ws, name)
    if not (directory / "known_hosts").is_file():
        raise Failure("guest host key has not been authenticated; provisioning must export its host key before SSH observation", 3)
    script = "Get-Content -Raw -LiteralPath 'C:\\ProgramData\\WinBoatDev\\provisioning.json'"
    import base64
    command = "powershell.exe -NoProfile -EncodedCommand " + base64.b64encode(script.encode("utf-16le")).decode()
    result = run(ssh_command(directory, record) + [command])
    observed = json.loads(result.stdout)
    if (observed.get("schemaVersion") != 1 or observed.get("computerName") != "WB-DEVBOX"
            or observed.get("lockSha256") != record["provisioning"]["lockSha256"]):
        raise Failure("unexpected guest identity or inventory schema", 3)
    write_json(directory / "guest-observation.json", {"observed": time.time(), "transport": "key-authenticated-ssh", **observed})
    record["provisioning"].update(phase=observed["phase"], installed=observed.get("phase") == "verified",
                                   verified=observed.get("phase") == "verified" and observed.get("signedDriverLoaded") is True)
    write_json(directory / "devbox.json", record)
    ws.journal(operation_id, {"kind": "devbox-guest-status", "state": "observed", "name": name,
                              "guestObservation": str(directory / "guest-observation.json")})
    return observed


def viewer(ws, name, action, operation_id):
    directory, record = load(ws, name)
    path = directory / "viewer.json"
    previous = json.loads(path.read_text()) if path.exists() else {}
    pid = previous.get("pid")
    # Verify PID reuse using the Linux process start tick and selected executable.
    running = False
    if pid:
        try:
            running = (Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19] == previous["startTick"]
                       and str(Path(f"/proc/{pid}/exe").resolve()) == previous["executable"])
        except (OSError, KeyError):
            pass
    if action == "status":
        return {"state": "open" if running else "closed", "backend": "tigervnc", "pid": pid if running else None}
    if action == "close":
        if running:
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                if viewer(ws, name, "status", operation_id)["state"] == "closed":
                    break
                time.sleep(0.1)
            else:
                raise Failure("viewer did not close; VM remains running", 3)
        return {"state": "closed", "backend": "tigervnc", "vmStopped": False}
    if running:
        return {"state": "open", "backend": "tigervnc", "pid": pid}
    if not capabilities(ws, probe_runtime=False)["display"]["available"]:
        raise Failure("viewer requires an interactive display; the headless VM can remain running", 3)
    if status(ws, name)["state"] != "running":
        raise Failure("start this devbox before opening its viewer", 3)
    with (directory / "viewer.log").open("a") as log:
        process = subprocess.Popen([os.environ["WB_VNCVIEWER"], "-Shared", "-SecurityTypes", "None",
                                    f"127.0.0.1::{record['ports']['viewer']}"],
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    time.sleep(0.2)
    if process.poll() is not None:
        raise Failure("VNC viewer exited on startup", 3, log=str(directory / "viewer.log"))
    observation = {"pid": process.pid, "executable": str(Path(f"/proc/{process.pid}/exe").resolve()),
                   "startTick": Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19], "backend": "tigervnc"}
    write_json(path, observation)
    ws.journal(operation_id, {"kind": "devbox-viewer", "state": "open", "name": name, **observation})
    return {"state": "open", "backend": "tigervnc", "pid": process.pid, "vmStopped": False}


def dispatch(ws, args, operation_id):
    if args.action == "capabilities":
        return capabilities(ws)
    if args.action == "media":
        return media(ws, args.iso, args.iso_sha256, args.index, args.edition, args.locale)
    if args.action == "create":
        return create(ws, args, operation_id)
    if args.action == "status":
        result = status(ws, args.name)
        result["identity"] = load(ws, args.name)[1]["identity"]
        return result
    if args.action == "logs":
        directory, _ = load(ws, args.name)
        logs = {}
        for path in directory.glob("*.log"):
            with path.open("rb") as handle:
                handle.seek(max(0, path.stat().st_size - 65536))
                logs[path.name] = handle.read(65536).decode(errors="replace")
        return {"name": args.name, "logs": logs, "boundedBytesPerLog": 65536}
    if args.action == "up":
        return up(ws, args.name, operation_id, args.rebuild_image)
    if args.action == "down":
        return down(ws, args.name, operation_id, args.force)
    if args.action == "restart":
        down(ws, args.name, operation_id)
        return up(ws, args.name, operation_id)
    if args.action == "destroy":
        return destroy(ws, args.name, args.confirm, operation_id)
    if args.action == "viewer":
        return viewer(ws, args.name, args.viewer_action, operation_id)
    if args.action == "guest-status":
        return guest_status(ws, args.name, operation_id)
    raise Failure("unknown devbox operation", 2)
