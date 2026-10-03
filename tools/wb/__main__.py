import argparse
import json
import os
from pathlib import Path
import shutil
import sys

from . import activation, builds, devbox, jobs, publication, repos
from .common import Failure, git, identity, run, valid_ref, valid_sha, write_json
from .workspace import Workspace, discover


def selectors(parser):
    parser.add_argument("--subset")
    parser.add_argument("--repo", action="append", default=[])


def parser():
    root = argparse.ArgumentParser(prog="wb")
    root.add_argument("--workspace")
    root.add_argument("--json", action="store_true")
    root.add_argument("--repositories-root")
    root.add_argument("--state-root")
    root.add_argument("--out-root")
    commands = root.add_subparsers(dest="family", required=True)
    setup = commands.add_parser("setup")
    setup.add_argument("--activation", choices=["bash", "zsh", "fish", "nu"])
    setup.add_argument("--shell-config")
    doctor = commands.add_parser("doctor")
    selectors(doctor)
    doctor.add_argument("--remote", action="store_true")
    doctor.add_argument("--shell", choices=["bash", "zsh", "fish", "nu"])
    doctor.add_argument("--shell-config")
    repo = commands.add_parser("repo").add_subparsers(dest="action", required=True)
    for name in ["list", "status", "plan", "sync", "verify", "checkpoint", "pin", "push", "fork", "branch"]:
        command = repo.add_parser(name)
        selectors(command)
        if name in {"sync", "push", "verify"}:
            command.add_argument("--background", action="store_true")
        if name == "branch":
            command.add_argument("--name")
        if name == "checkpoint":
            command.add_argument("--path", action="append", required=True)
            command.add_argument("--message", required=True)
        if name == "pin":
            command.add_argument("--rev", required=True)
            command.add_argument("--ref")
            command.add_argument("--source-url")
            command.add_argument("--defer-checkpoint", action="store_true")
        if name == "push":
            command.add_argument("--remote", default="origin")
            command.add_argument("--source", default="HEAD")
            command.add_argument("--force-with-lease", action="store_true")
            command.add_argument("--dry-run", action="store_true")
            command.add_argument("--defer-checkpoint", action="store_true")
        if name == "fork":
            command.add_argument("--namespace")
            command.add_argument("--apply", action="store_true")
    reconcile = repo.add_parser("reconcile")
    reconcile.add_argument("--operation", required=True)
    build = commands.add_parser("build")
    build.add_argument("target", nargs="?", default="list")
    build.add_argument("--plan", action="store_true")
    build.add_argument("--configuration", choices=["release", "debug"], default="release")
    build.add_argument("--mode", choices=["release", "development"], default="release")
    build.add_argument("--background", action="store_true")
    build.add_argument("--manifest")
    dev = commands.add_parser("devbox").add_subparsers(dest="action", required=True)
    dev.add_parser("capabilities")
    cdi = dev.add_parser("cdi").add_subparsers(dest="cdi_action", required=True)
    cdi.add_parser("prepare").add_argument("--render-node")
    for name in ["media", "create", "up", "down", "restart", "status", "logs", "destroy", "guest-status", "viewer"]:
        command = dev.add_parser(name)
        command.add_argument("--name", default="default")
        if name in {"media", "create"}:
            command.add_argument("--iso", required=name == "media")
            command.add_argument("--iso-sha256")
            command.add_argument("--index", type=int)
            command.add_argument("--edition")
            command.add_argument("--locale", default="en-US")
        if name == "create":
            command.add_argument("--runtime", choices=["docker", "podman"])
            command.add_argument("--render-node")
            command.add_argument("--graphics-provider", choices=["auto", "mesa", "nvidia-cdi"])
            command.add_argument("--cdi-device")
            command.add_argument("--manifest")
            command.add_argument("--start", action="store_true")
        if name == "up":
            command.add_argument("--rebuild-image", action="store_true")
        if name == "down":
            command.add_argument("--force", action="store_true")
        if name in {"down", "restart"}:
            command.add_argument("--timeout", type=int, default=120)
        if name in {"create", "up", "down", "restart", "guest-status"}:
            command.add_argument("--background", action="store_true")
        if name == "destroy":
            command.add_argument("--confirm", required=True)
        if name == "viewer":
            command.add_argument("viewer_action", choices=["open", "close", "status"])
    job = commands.add_parser("job").add_subparsers(dest="action", required=True)
    for name in ["status", "cancel", "resume", "run"]:
        job.add_parser(name).add_argument("--id", required=True)
    commands.add_parser("mcp")
    return root


def single(args):
    names = list(dict.fromkeys("clvk-helios" if n == "clkvk-helios" else n for n in args.repo))
    if len(names) != 1 or args.subset:
        raise Failure("this command requires exactly one --repo", 2)
    return names


def dispatch(ws, args, operation_id, argv):
    if args.family == "setup":
        ws.state.mkdir(parents=True, exist_ok=True)
        local = ws.root / "local.json"
        if not local.exists():
            write_json(local, {"schemaVersion": 1, "workspace": {}})
        result = {"localConfig": str(local), "stateRoot": str(ws.state), "state": "prepared"}
        if args.activation:
            result["activation"] = activation.setup(ws, args.activation, args.shell_config)
        return result
    if args.family == "job":
        return {"status": jobs.status, "cancel": jobs.cancel, "resume": jobs.resume, "run": jobs.execute}[args.action](ws, args.id)
    if args.family == "mcp":
        os.environ["WB_WORKSPACE_ROOT"] = str(ws.root)
        os.execv(os.environ["WB_NODE"], [os.environ["WB_NODE"], os.environ["WB_MCP_SERVER"]])
    if args.family == "repo" and args.action == "reconcile":
        return publication.reconcile(ws, args.operation)
    if args.family == "devbox":
        if getattr(args, "background", False):
            return jobs.start(ws, [v for v in argv if v != "--background"])
        return devbox.dispatch(ws, args, operation_id)
    if args.family == "build":
        if args.target == "list":
            return builds.catalog()
        if args.target == "verify":
            if not args.manifest:
                raise Failure("build verify requires --manifest", 2)
            return builds.verify(args.manifest)
        if args.plan:
            return builds.plan(ws, args.target, args.configuration, args.mode)
        if args.background:
            return jobs.start(ws, [v for v in argv if v != "--background"])
        return builds.execute(ws, args.target, args.configuration, args.mode, operation_id)
    selected, containers = ws.select(args)
    if args.family == "doctor":
        tools = {name: shutil.which(name) for name in ["git", "node", "python3", "devenv", "nix", "ssh", "direnv"]}
        result = {"tools": tools, "lockPresent": (ws.root / "devenv.lock").is_file(), "repositories": ws.status(selected),
                  "activation": activation.doctor(ws, args.shell, args.shell_config),
                  "capabilities": {"kvm": os.access("/dev/kvm", os.R_OK | os.W_OK),
                                   "interactiveDisplay": bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("DISPLAY")),
                                   "containerRuntime": shutil.which("podman") or shutil.which("docker")},
                  "gitInterception": {"executable": shutil.which("git"), "absoluteGitBypass": True,
                                      "remedy": "use the locked shell's git or wb repo push"}}
        if args.remote:
            result["verification"] = repos.verify(ws, selected)
        else:
            evidence = ws.state / "verification/sources.json"
            result["remoteVerification"] = json.loads(evidence.read_text()) if evidence.exists() else {"state": "unverified", "remedy": "wb repo verify --subset <selection>"}
        result["devboxCapabilities"] = devbox.capabilities(ws)
        return result
    if getattr(args, "background", False):
        return jobs.start(ws, [v for v in argv if v != "--background"])
    if args.action == "list":
        return {"selected": selected, "containers": containers,
                "repositories": [{"repository": n, **ws.repos[n], "path": str(ws.paths[n])} for n in selected]}
    if args.action == "status":
        return {"selected": selected, "repositories": ws.status(selected), "containers": containers}
    if args.action == "plan":
        return repos.plan(ws, selected, containers)
    if args.action == "sync":
        return repos.sync(ws, selected, containers, operation_id)
    if args.action == "verify":
        return repos.verify(ws, selected)
    if args.action == "branch":
        return repos.branch(ws, single(args), args.name)
    if args.action == "fork":
        return repos.fork(ws, selected, args.namespace, operation_id, args.apply)
    if args.action == "checkpoint":
        return publication.checkpoint(ws, selected, args.path, args.message, operation_id)
    if args.action == "pin":
        name = single(args)[0]
        if not valid_sha(args.rev) or (args.ref and not valid_ref(args.ref)):
            raise Failure("pin requires an exact revision and a full refs/heads/... ref", 2)
        with ws.repo_locks([name]):
            fields = {"rev": args.rev, "provenance": "explicit-verified-pin"}
            if args.ref:
                fields["ref"] = args.ref
            if args.source_url:
                if args.source_url.startswith("-") or "${" in args.source_url or "\n" in args.source_url:
                    raise Failure("invalid source URL", 2)
                fields["sourceUrl"] = args.source_url
                ws.repos[name]["fetchUrl"] = args.source_url
            repos.cache_object(ws, name, args.rev)
            parent = ws.repos[name]["parent"]
            if parent:
                cache = repos.cache_object(ws, parent)
                if repos.gitlink(cache, ws.repos[parent]["pin"]["rev"], ws.repos[name]["submodulePath"]) != args.rev:
                    raise Failure("pin update disagrees with parent gitlink; publish a coherent child/parent transaction")
            result = publication.pin_transaction(ws, {name: fields}, {name: ws.repos[name]["pin"]["rev"]}, operation_id, args.defer_checkpoint)
            ws.journal(operation_id, {"kind": "pin", "state": "succeeded", "repository": name, "fields": fields, **result})
            return result
    if args.action == "push":
        records = []
        for name in ws.order(selected, children_first=True):
            ws.refresh()
            parent = ws.repos[name]["parent"]
            with ws.repo_locks([name] + ([parent] if parent else [])):
                target = ws.repos[name]["pin"]["ref"]
                if not target:
                    raise Failure("development ref unresolved: " + name, 2)
                push_args = [args.remote, args.source + ":" + target]
                if args.force_with_lease:
                    push_args.insert(0, "--force-with-lease")
                if args.dry_run:
                    push_args.insert(0, "--dry-run")
                record = publication.push(ws, name, [], push_args, identity(), args.defer_checkpoint)
                records.append(record)
                if record.get("exitCode", 0):
                    raise Failure("push failed: " + name, record["exitCode"], transactions=records)
        return {"state": "succeeded", "transactions": records,
                "externalStep": "publish pending parents listed in each transaction" if any(r.get("pendingParents") for r in records) else None}
    raise Failure("unsupported operation", 2)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "git-wrapper":
        return publication.git_wrapper(argv[1:])
    # Global flags are accepted anywhere, keeping human/MCP invocation identical.
    globals_, rest = [], []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value == "--json":
            globals_.append(value)
        elif value in {"--workspace", "--repositories-root", "--state-root", "--out-root"}:
            globals_.extend(argv[index:index + 2])
            index += 1
        else:
            rest.append(value)
        index += 1
    arguments = parser().parse_args(globals_ + rest)
    operation_id = identity()
    code = 0
    try:
        overrides = {key: value for key, value in {"repositoriesRoot": arguments.repositories_root,
                      "stateRoot": arguments.state_root, "outRoot": arguments.out_root}.items() if value is not None}
        ws = Workspace(discover(arguments.workspace), overrides)
        # Detached job workers and MCP children inherit the exact invocation
        # paths. Their state/config remains consistent after client disconnect.
        if overrides:
            os.environ["WB_INVOCATION_PATHS"] = json.dumps(overrides)
        result = dispatch(ws, arguments, operation_id, rest)
        code = result.get("exitCode", 0)
        payload = {"schemaVersion": 1, "operationId": operation_id, "state": result.get("state", "succeeded"),
                   "exitCode": code, "evidencePaths": [str(ws.state / "operations" / (operation_id + ".json"))]
                   if (ws.state / "operations" / (operation_id + ".json")).exists() else [], "result": result}
    except (Failure, OSError, ValueError, KeyError) as exc:
        code = exc.code if isinstance(exc, Failure) else 1
        payload = {"schemaVersion": 1, "operationId": operation_id, "state": "failed", "exitCode": code,
                   "error": str(exc), "details": exc.details if isinstance(exc, Failure) else {}, "evidencePaths": []}
    if not arguments.json and code:
        print(payload.get("error", "operation failed"), file=sys.stderr)
    print(json.dumps(payload, indent=None if arguments.json else 2))
    return code


if __name__ == "__main__":
    sys.exit(main())
