#!/usr/bin/env node
import {
  path,
  env,
  Failure,
  git,
  identity,
  valid_ref,
  valid_sha,
  write_json,
  readJSON,
  exists,
  mkdir,
  file,
  which,
  accessible,
} from "./common.mjs";
import { Workspace, discover } from "./workspace.mjs";
import * as builds from "./builds.mjs";
import * as devbox from "./devbox.mjs";
import * as jobs from "./jobs.mjs";
import * as publication from "./publication.mjs";
import * as repos from "./repos.mjs";
const schema = readJSON(new URL("./cli-schema.json", import.meta.url).pathname);
const globalNames = Object.keys(schema.options);
export function parse(argv) {
  let current = schema,
    positional = 0;
  const args = {};
  const defaults = (s) => {
    for (const o of [...Object.values(s.options), ...s.positionals])
      if (o.default !== undefined) args[o.dest] = structuredClone(o.default);
  };
  defaults(current);
  const seen = new Set(),
    selected = [schema];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--help" || value === "-h") {
      return { help: true, schema: current };
    }
    if (value.startsWith("--")) {
      const at = value.indexOf("="),
        flag = at < 0 ? value : value.slice(0, at),
        o = current.options[flag] ?? schema.options[flag];
      if (!o) throw new Failure("unrecognized argument: " + flag, 2);
      if (o.boolean) {
        if (at >= 0) throw new Failure(flag + " does not take a value", 2);
        args[o.dest] = true;
      } else {
        let v = at < 0 ? argv[++i] : value.slice(at + 1);
        if (v === undefined || (at < 0 && v.startsWith("--")))
          throw new Failure(flag + " requires a value", 2);
        if (o.type === "integer") {
          if (!/^[+-]?\d+$/.test(v))
            throw new Failure(flag + " requires an integer", 2);
          v = Number(v);
          if (!Number.isSafeInteger(v))
            throw new Failure(flag + " requires a safe integer", 2);
        }
        if (o.choices && !o.choices.includes(v))
          throw new Failure("unsupported value for " + flag, 2);
        if (o.multiple) (args[o.dest] ??= []).push(v);
        else args[o.dest] = v;
      }
      seen.add(o.dest);
      continue;
    }
    if (current.commandDest) {
      const child = current.commands[value];
      if (!child)
        throw new Failure("unknown " + current.commandDest + ": " + value, 2);
      args[current.commandDest] = value;
      current = child;
      selected.push(child);
      positional = 0;
      defaults(child);
    } else {
      const o = current.positionals[positional++];
      if (!o) throw new Failure("unrecognized argument: " + value, 2);
      if (o.choices && !o.choices.includes(value))
        throw new Failure("unsupported " + o.dest, 2);
      args[o.dest] = value;
      seen.add(o.dest);
    }
  }
  if (current.commandDest)
    throw new Failure("required command: " + current.commandDest, 2);
  for (const s of selected)
    for (const o of [...Object.values(s.options), ...s.positionals])
      if (o.required && !seen.has(o.dest))
        throw new Failure("required argument: " + o.dest, 2);
  return args;
}
function single(args) {
  const names = [
    ...new Set(
      args.repo.map((n) => (n === "clkvk-helios" ? "clvk-helios" : n)),
    ),
  ];
  if (names.length !== 1 || args.subset)
    throw new Failure("this command requires exactly one --repo", 2);
  return names;
}
export async function dispatch(ws, args, operationId, argv) {
  if (args.family === "setup") {
    mkdir(ws.state);
    const local = path.join(ws.root, "local.json");
    if (!exists(local)) write_json(local, { schemaVersion: 1, workspace: {} });
    return { localConfig: local, stateRoot: ws.state, state: "prepared" };
  }
  if (args.family === "job")
    return {
      status: jobs.status,
      cancel: jobs.cancel,
      resume: jobs.resume,
      run: jobs.execute,
    }[args.action](ws, args.id);
  if (args.family === "mcp") {
    env.WB_WORKSPACE_ROOT = ws.root;
    await import(
      env.WB_MCP_SERVER || new URL("../mcp/server.mjs", import.meta.url).href
    );
    return null;
  }
  if (args.family === "repo" && args.action === "reconcile")
    return publication.reconcile(ws, args.operation);
  if (args.family === "devbox")
    return args.background
      ? jobs.start(
          ws,
          argv.filter((v) => v !== "--background"),
        )
      : devbox.dispatch(ws, args, operationId);
  if (args.family === "build") {
    if (args.target === "list") return builds.catalog();
    if (args.target === "verify") {
      if (!args.manifest)
        throw new Failure("build verify requires --manifest", 2);
      return builds.verify(args.manifest);
    }
    if (args.plan)
      return builds.plan(ws, args.target, args.configuration, args.mode);
    if (args.background)
      return jobs.start(
        ws,
        argv.filter((v) => v !== "--background"),
      );
    return builds.execute(
      ws,
      args.target,
      args.configuration,
      args.mode,
      operationId,
      args.name,
    );
  }
  const [selected, containers] = ws.select(args);
  if (args.family === "doctor") {
    const result = {
      tools: Object.fromEntries(
        ["git", "node", "devenv", "nix", "ssh"].map((n) => [n, which(n)]),
      ),
      lockPresent: file(path.join(ws.root, "devenv.lock")),
      repositories: ws.status(selected),
      capabilities: {
        kvm: accessible("/dev/kvm"),
        interactiveDisplay: !!(env.WAYLAND_DISPLAY || env.DISPLAY),
        containerRuntime: which("podman") || which("docker"),
      },
      gitInterception: {
        executable: which("git"),
        absoluteGitBypass: true,
        remedy: "use the locked shell's git or wb repo push",
      },
    };
    if (args.remote) result.verification = repos.verify(ws, selected);
    else {
      const evidence = path.join(ws.state, "verification/sources.json");
      result.remoteVerification = exists(evidence)
        ? readJSON(evidence)
        : {
            state: "unverified",
            remedy: "wb repo verify --subset <selection>",
          };
    }
    result.devboxCapabilities = devbox.capabilities(ws);
    return result;
  }
  if (args.background)
    return jobs.start(
      ws,
      argv.filter((v) => v !== "--background"),
    );
  switch (args.action) {
    case "list":
      return {
        selected,
        containers,
        repositories: selected.map((n) => ({
          repository: n,
          ...ws.repos[n],
          path: ws.paths[n],
        })),
      };
    case "status":
      return { selected, repositories: ws.status(selected), containers };
    case "plan":
      return repos.plan(ws, selected, containers);
    case "sync":
      return repos.sync(ws, selected, containers, operationId);
    case "verify":
      return repos.verify(ws, selected);
    case "branch":
      return repos.branch(ws, single(args), args.name);
    case "fork":
      return repos.fork(ws, selected, args.namespace, operationId, args.apply);
    case "checkpoint":
      return publication.checkpoint(
        ws,
        selected,
        args.path,
        args.message,
        operationId,
      );
    case "pin": {
      const name = single(args)[0];
      if (!valid_sha(args.rev) || (args.ref && !valid_ref(args.ref)))
        throw new Failure(
          "pin requires an exact revision and a full refs/heads/... ref",
          2,
        );
      return ws.repo_locks([name], async () => {
        const fields = { rev: args.rev, provenance: "explicit-verified-pin" };
        if (args.ref) fields.ref = args.ref;
        if (args.source_url) {
          if (
            args.source_url.startsWith("-") ||
            args.source_url.includes("${") ||
            /[\n\0]/.test(args.source_url)
          )
            throw new Failure("invalid source URL", 2);
          fields.sourceUrl = args.source_url;
          ws.repos[name].fetchUrl = args.source_url;
        }
        repos.cache_object(ws, name, args.rev);
        const parent = ws.repos[name].parent;
        if (
          parent &&
          repos.gitlink(
            repos.cache_object(ws, parent),
            ws.repos[parent].pin.rev,
            ws.repos[name].submodulePath,
          ) !== args.rev
        )
          throw new Failure(
            "pin update disagrees with parent gitlink; publish a coherent child/parent transaction",
          );
        const result = await publication.pin_transaction(
          ws,
          { [name]: fields },
          { [name]: ws.repos[name].pin.rev },
          operationId,
          args.defer_checkpoint,
        );
        ws.journal(operationId, {
          kind: "pin",
          state: "succeeded",
          repository: name,
          fields,
          ...result,
        });
        return result;
      });
    }
    case "push": {
      const records = [];
      for (const name of ws.order(selected, true)) {
        ws.refresh();
        const parent = ws.repos[name].parent;
        await ws.repo_locks([name, ...(parent ? [parent] : [])], async () => {
          const target = ws.repos[name].pin.ref;
          if (!target)
            throw new Failure("development ref unresolved: " + name, 2);
          const pushArgs = [
              ...(args.force_with_lease ? ["--force-with-lease"] : []),
              ...(args.dry_run ? ["--dry-run"] : []),
              args.remote,
              args.source + ":" + target,
            ],
            record = await publication.push(
              ws,
              name,
              [],
              pushArgs,
              identity(),
              args.defer_checkpoint,
            );
          records.push(record);
          if (record.exitCode)
            throw new Failure("push failed: " + name, record.exitCode, {
              transactions: records,
            });
        });
      }
      return {
        state: "succeeded",
        transactions: records,
        externalStep: records.some((r) => r.pendingParents?.length)
          ? "publish pending parents listed in each transaction"
          : null,
      };
    }
    default:
      throw new Failure("unsupported operation", 2);
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "git-wrapper") return publication.git_wrapper(argv.slice(1));
  const operationId = identity();
  let code = 0,
    ws,
    args,
    payload;
  try {
    args = parse(argv);
    if (args.help) {
      const s = args.schema;
      process.stdout.write(
        "usage: wb " +
          (Object.keys(s.commands).length
            ? "{" + Object.keys(s.commands).join(",") + "}"
            : s.positionals.map((p) => p.dest).join(" ")) +
          " [options]\n" +
          Object.keys(s.options).join("\n") +
          "\n",
      );
      return 0;
    }
    const overrides = Object.fromEntries(
      [
        ["repositoriesRoot", args.repositories_root],
        ["stateRoot", args.state_root],
        ["outRoot", args.out_root],
      ].filter(([, v]) => v != null),
    );
    ws = new Workspace(discover(args.workspace), overrides);
    if (Object.keys(overrides).length)
      env.WB_INVOCATION_PATHS = JSON.stringify(overrides);
    // Jobs store only operation arguments; path overrides are inherited by the
    // detached worker. JSON formatting flags must not enter the operation.
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i].split("=")[0];
      if (globalNames.includes(flag)) {
        if (flag !== "--json" && !argv[i].includes("=")) i++;
      } else rest.push(argv[i]);
    }
    const result = await dispatch(ws, args, operationId, rest);
    if (args.family === "mcp") return 0;
    code = result.exitCode ?? 0;
    const receipt = path.join(ws.state, "operations", operationId + ".json");
    payload = {
      schemaVersion: 1,
      operationId,
      state: result.state ?? "succeeded",
      exitCode: code,
      evidencePaths: exists(receipt) ? [receipt] : [],
      result,
    };
  } catch (e) {
    code = e instanceof Failure ? e.code : 1;
    const receipt =
      ws && path.join(ws.state, "operations", operationId + ".json");
    payload = {
      schemaVersion: 1,
      operationId,
      state: "failed",
      exitCode: code,
      error: e.message,
      details: e instanceof Failure ? e.details : {},
      evidencePaths: receipt && exists(receipt) ? [receipt] : [],
    };
  }
  const json = args?.json ?? argv.includes("--json");
  if (!json && code)
    process.stderr.write((payload.error ?? "operation failed") + "\n");
  process.stdout.write(
    JSON.stringify(payload, null, json ? undefined : 2) + "\n",
  );
  return code;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
  process.exitCode = await main();
