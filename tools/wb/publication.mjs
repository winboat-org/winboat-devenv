import {
  fs,
  path,
  os,
  env,
  Failure,
  atomic_write,
  edit_pins,
  git,
  identity,
  locked,
  parse_pins,
  run,
  valid_sha,
  read,
  readJSON,
  list,
  within,
  resolve,
  file,
  dir,
  accessible,
} from "./common.mjs";
import { gitlink } from "./repos.mjs";
import { Workspace, discover } from "./workspace.mjs";
export function scoped_commit(
  p,
  entries,
  message,
  staged_entries = entries,
  expected_blobs = {},
) {
  const head = git(p, "rev-parse", "HEAD").stdout.trim(),
    index = git(
      p,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ).stdout.trim(),
    lock = index + ".lock";
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Failure(
        "Git index is locked; retry the checkpoint after the other Git operation finishes",
      );
    throw e;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-index-"));
  try {
    for (const [relative, expected] of Object.entries(expected_blobs))
      if (git(p, "show", ":" + relative).stdout !== expected)
        throw new Failure(
          "staged pin data changed while planning; reconcile the receipt",
        );
    fs.copyFileSync(index, lock);
    const update = (table, indexPath) => {
      for (const [relative, [mode, oid]] of Object.entries(table))
        git(
          p,
          "update-index",
          ...(mode === null
            ? ["--force-remove", "--", relative]
            : ["--add", "--cacheinfo", mode, oid, relative]),
          { env: { GIT_INDEX_FILE: indexPath } },
        );
    };
    update(staged_entries, lock);
    const temporaryIndex = path.join(tmp, "index");
    git(p, "read-tree", head, { env: { GIT_INDEX_FILE: temporaryIndex } });
    update(entries, temporaryIndex);
    const tree = git(p, "write-tree", {
        env: { GIT_INDEX_FILE: temporaryIndex },
      }).stdout.trim(),
      oldtree = git(p, "rev-parse", head + "^{tree}").stdout.trim();
    let newhead = head;
    if (tree !== oldtree) {
      newhead = git(p, "commit-tree", tree, "-p", head, {
        input: message + "\n",
      }).stdout.trim();
      git(p, "update-ref", "HEAD", newhead, head);
    }
    fs.renameSync(lock, index);
    return newhead;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  }
}
export async function pin_transaction(
  ws,
  updates,
  expected,
  operationId,
  defer = false,
) {
  return locked(path.join(ws.state, "locks/pins.lock"), () => {
    const working = read(ws.pins_path),
      current = parse_pins(working).repositories;
    for (const [n, fields] of Object.entries(updates))
      if (![expected[n], fields.rev ?? expected[n]].includes(current[n].rev))
        throw new Failure("pin compare-and-swap conflict: " + n);
    const rendered = edit_pins(working, updates);
    if (env.WB_TEST_FAIL_PIN_WRITE === "1")
      throw new Failure("injected pin-write failure");
    atomic_write(ws.pins_path, rendered);
    if (defer) return { deferred: true, rootCommit: null };
    const head = git(ws.root, "show", "HEAD:nix/pins.nix").stdout,
      index = git(ws.root, "show", ":nix/pins.nix").stdout;
    const committedOid = git(ws.root, "hash-object", "-w", "--stdin", {
        input: edit_pins(head, updates),
      }).stdout.trim(),
      stagedOid = git(ws.root, "hash-object", "-w", "--stdin", {
        input: edit_pins(index, updates),
      }).stdout.trim();
    if (env.WB_TEST_FAIL_PIN_COMMIT === "1")
      throw new Failure("injected pin-commit failure");
    const kind = Object.values(updates).every(
      (f) => f.provenance === "verified-push",
    )
      ? "publication"
      : "source pin";
    return {
      deferred: false,
      rootCommit: scoped_commit(
        ws.root,
        { "nix/pins.nix": ["100644", committedOid] },
        "chore(pins): record verified " + kind + " " + operationId,
        { "nix/pins.nix": ["100644", stagedOid] },
        { "nix/pins.nix": index },
      ),
    };
  });
}
export function update_parent(ws, name, revision) {
  const parent = ws.repos[name].parent;
  if (!parent) return [];
  const p = ws.validate_checkout(parent, true),
    relative = ws.repos[name].submodulePath,
    old = gitlink(p, "HEAD", relative),
    staged = git(p, "ls-files", "--stage", "--", relative)
      .stdout.trim()
      .split(/\s+/);
  if (
    !staged.length ||
    ![old, revision].includes(staged[1]) ||
    staged[2] !== "0"
  )
    throw new Failure(
      "parent gitlink has unrelated staged/conflicted work: " + parent,
    );
  const commit = scoped_commit(
    p,
    { [relative]: ["160000", revision] },
    "chore(deps): record " + name + " " + revision,
  );
  return [
    {
      repository: parent,
      commit,
      gitlink: relative,
      child: name,
      state: "needs-publication",
    },
  ];
}
export async function finish_push(ws, receipt) {
  const name = receipt.repository,
    revision = receipt.pushedRevision;
  receipt.pendingParents = update_parent(ws, name, revision);
  ws.journal(receipt.operationId, receipt);
  const result = await pin_transaction(
    ws,
    { [name]: { rev: revision, provenance: "verified-push" } },
    { [name]: receipt.expectedOldPin },
    receipt.operationId,
    receipt.deferCheckpoint ?? false,
  );
  Object.assign(receipt, result, {
    state: result.deferred ? "deferred" : "succeeded",
  });
  ws.journal(receipt.operationId, receipt);
  for (const p of list(path.join(ws.state, "operations")).filter((p) =>
    p.endsWith(".json"),
  )) {
    const previous = readJSON(p);
    let changed = false;
    for (const parent of previous.pendingParents ?? [])
      if (
        parent.repository === name &&
        parent.state === "needs-publication" &&
        previous.pushedRevision &&
        gitlink(ws.paths[name], revision, parent.gitlink) ===
          previous.pushedRevision
      ) {
        Object.assign(parent, {
          state: "published",
          publishedCommit: revision,
          publicationOperation: receipt.operationId,
        });
        changed = true;
      }
    if (changed) ws.journal(previous.operationId, previous);
  }
  return receipt;
}
export function remote_revision(url, ref) {
  const lines = run([env.WB_REAL_GIT, "ls-remote", "--refs", url, ref])
    .stdout.split("\n")
    .filter((l) => l.endsWith("\t" + ref))
    .map((l) => l.split(/\s+/));
  if (lines.length !== 1 || !valid_sha(lines[0][0]))
    throw new Failure("remote development ref cannot be verified", 1, {
      remote: url,
      ref,
    });
  return lines[0][0];
}
export async function push(
  ws,
  name,
  global_args,
  push_args,
  operationId,
  defer = false,
) {
  const p = ws.validate_checkout(name, true),
    prefix = global_args.length
      ? [env.WB_REAL_GIT, ...global_args]
      : [env.WB_REAL_GIT, "-C", p];
  const passthrough = (state) => {
    const r = run([...prefix, "push", ...push_args], { check: false });
    return {
      state: typeof state === "function" ? state(r) : state,
      exitCode: r.returncode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  };
  if (push_args.some((a) => ["--dry-run", "-n"].includes(a)))
    return passthrough("dry-run");
  if (
    push_args.some(
      (a) =>
        ["--all", "--mirror", "--prune"].includes(a) || a.startsWith("--repo="),
    )
  )
    throw new Failure(
      "ambiguous managed push; use wb repo push --repo " +
        name +
        " --remote <remote> --source <ref>",
      2,
    );
  let target = ws.repos[name].pin.ref;
  if (!target)
    throw new Failure(
      "development ref unresolved; configure it with wb repo pin",
      2,
    );
  const preflight = run(
      [...prefix, "push", "--porcelain", "--dry-run", ...push_args],
      { check: false },
    ),
    effects = [],
    destinations = [];
  for (const l of preflight.stdout.split("\n")) {
    if (l.startsWith("To ")) destinations.push(l.slice(3));
    const c = l.split("\t");
    if (c.length === 3 && c[1].includes(":")) {
      const [source, destination] = c[1].split(":", 2);
      if (destination === target && source && c[0] !== "-")
        effects.push([source, destination]);
    }
  }
  if (!effects.length)
    return passthrough((r) =>
      r.returncode ? "push-failed" : "unselected-push",
    );
  if (effects.length !== 1 || destinations.length !== 1)
    throw new Failure(
      "multiple managed push destinations are ambiguous; use wb repo push with one remote",
      2,
    );
  const source = effects[0][0];
  target = effects[0][1];
  const candidate = run([
    ...prefix,
    "rev-parse",
    source + "^{commit}",
  ]).stdout.trim();
  if (!valid_sha(candidate))
    throw new Failure("push source is not an exact commit", 2);
  for (const [child, r] of Object.entries(ws.repos))
    if (
      r.parent === name &&
      gitlink(p, candidate, r.submodulePath) !== r.pin.rev
    )
      throw new Failure(
        "parent push disagrees with a managed child pin: " + child,
        1,
        {
          remedy:
            "publish the child first, then checkpoint/push the matching parent gitlink",
        },
      );
  const sourceUrl = ws.repos[name].pin.sourceUrl || ws.repos[name].fetchUrl,
    expanded = git(p, "ls-remote", "--get-url", sourceUrl).stdout.trim();
  if (destinations[0] !== expanded)
    throw new Failure(
      "push destination differs from the pinned source URL; explicitly select the fork with wb repo pin --source-url",
      2,
      { destination: destinations[0], sourceUrl },
    );
  const receipt = {
    schemaVersion: 1,
    operationId,
    kind: "push",
    state: "prepared",
    repository: name,
    remote: destinations[0],
    ref: target,
    pushedRevision: candidate,
    expectedOldPin: ws.repos[name].pin.rev,
    deferCheckpoint: defer,
    pendingParents: [],
    gitArguments: [...global_args, "push", ...push_args],
  };
  ws.journal(operationId, receipt);
  const real = run([...prefix, "push", ...push_args], { check: false });
  Object.assign(receipt, {
    gitExitCode: real.returncode,
    stdout: real.stdout,
    stderr: real.stderr,
  });
  if (real.returncode) {
    receipt.state = "push-failed";
    ws.journal(operationId, receipt);
    return { ...receipt, exitCode: real.returncode };
  }
  receipt.state = "remote-pushed";
  ws.journal(operationId, receipt);
  try {
    const verified = remote_revision(receipt.remote, target);
    if (verified !== candidate)
      throw new Failure("remote moved after push; refusing to guess pin", 1, {
        expected: candidate,
        observed: verified,
      });
    receipt.remoteVerified = true;
    ws.journal(operationId, receipt);
    return await finish_push(ws, receipt);
  } catch (e) {
    Object.assign(receipt, { state: "partial", error: e.message });
    ws.journal(operationId, receipt);
    throw new Failure(
      "remote push succeeded; local checkpoint is incomplete. Run wb repo reconcile --operation " +
        operationId,
      1,
      { receiptId: operationId, remotePushed: true },
    );
  }
}
export async function reconcile(ws, operationId) {
  if (!/^op-[0-9a-f]{32}$/.test(operationId))
    throw new Failure("invalid operation ID", 2);
  const receipt = readJSON(
    path.join(ws.state, "operations", operationId + ".json"),
  );
  if (receipt.schemaVersion !== 1 || receipt.kind !== "push")
    throw new Failure("receipt is not a supported push transaction", 2);
  const n = receipt.repository;
  return ws.repo_locks(
    [n, ...(ws.repos[n].parent ? [ws.repos[n].parent] : [])],
    () => {
      if (
        remote_revision(receipt.remote, receipt.ref) !== receipt.pushedRevision
      )
        throw new Failure(
          "remote no longer contains the receipt's pushed revision",
        );
      receipt.deferCheckpoint = false;
      receipt.remoteVerified = true;
      return finish_push(ws, receipt);
    },
  );
}
export async function checkpoint(ws, selected, paths, message, operationId) {
  if (!paths.length)
    throw new Failure(
      "checkpoint requires explicit --path <repo-relative-path> (repeatable)",
      2,
    );
  const commits = [];
  return ws.repo_locks(
    [...selected, ...selected.map((n) => ws.repos[n].parent).filter(Boolean)],
    () => {
      const prepared = {};
      for (const n of ws.order(selected, true)) {
        const p = ws.validate_checkout(n, true),
          entries = {};
        for (const requested of paths) {
          let relative = requested;
          if (requested.includes(":")) {
            const at = requested.indexOf(":"),
              owner = requested.slice(0, at);
            relative = requested.slice(at + 1);
            if (!selected.includes(owner))
              throw new Failure(
                "checkpoint path owner is outside selection: " + owner,
                2,
              );
            if (owner !== n) continue;
          }
          const target = resolve(path.resolve(p, relative));
          if (
            !relative ||
            path.isAbsolute(relative) ||
            !within(target, p) ||
            relative === "." ||
            relative.split("/").includes(".git")
          )
            throw new Failure(
              "checkpoint path must be explicit and within the repository",
              2,
            );
          if (dir(target))
            throw new Failure(
              "checkpoint requires file paths, not blanket directories",
              2,
            );
          if (!file(target)) {
            if (
              !git(p, "ls-files", "--error-unmatch", "--", relative, {
                check: false,
              }).returncode
            ) {
              entries[relative] = [null, null];
              continue;
            }
            throw new Failure("checkpoint path missing: " + relative, 2);
          }
          if (git(p, "ls-files", "--unmerged", "--", relative).stdout)
            throw new Failure(
              "checkpoint refuses unresolved conflicts: " + relative,
            );
          entries[relative] = [
            accessible(target, fs.constants.X_OK) ? "100755" : "100644",
            git(p, "hash-object", "-w", "--", relative).stdout.trim(),
          ];
        }
        prepared[n] = entries;
      }
      const receipt = {
        kind: "checkpoint",
        state: "running",
        commits,
        externalStep:
          "publish child commits before parents with wb repo push; source pins advance only after remote verification",
      };
      ws.journal(operationId, receipt);
      try {
        for (const n of ws.order(selected, true)) {
          if (!Object.keys(prepared[n]).length) continue;
          const head = scoped_commit(ws.paths[n], prepared[n], message),
            record = { repository: n, commit: head, pendingParents: [] };
          commits.push(record);
          ws.journal(operationId, receipt);
          record.pendingParents = update_parent(ws, n, head);
          ws.journal(operationId, receipt);
        }
        receipt.state = "succeeded";
        ws.journal(operationId, receipt);
        return receipt;
      } catch (e) {
        Object.assign(receipt, { state: "partial", error: e.message });
        ws.journal(operationId, receipt);
        throw new Failure(
          "checkpoint incomplete; completed commits are retained in receipt " +
            operationId,
          1,
          { receiptId: operationId, commits },
        );
      }
    },
  );
}
export function split_git_args(argv) {
  let i = 0;
  const values = [
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--config-env",
  ];
  while (i < argv.length) {
    const v = argv[i];
    if (values.includes(v)) i += 2;
    else if (v.startsWith("-")) i++;
    else return [argv.slice(0, i), v, argv.slice(i + 1)];
  }
  return [argv, null, []];
}
export async function git_wrapper(argv) {
  const [globalArgs, command, args] = split_git_args(argv),
    real = env.WB_REAL_GIT;
  const passthrough = () =>
    run([real, ...argv], { check: false, stdio: "inherit" }).returncode;
  if (command !== "push") return passthrough();
  const probe = run([real, ...globalArgs, "rev-parse", "--show-toplevel"], {
    check: false,
  });
  if (probe.returncode) return passthrough();
  let ws;
  try {
    ws = new Workspace(discover());
  } catch (e) {
    if (e instanceof Failure) return passthrough();
    throw e;
  }
  const p = resolve(probe.stdout.trim()),
    matches = Object.keys(ws.repos).filter((n) => ws.paths[n] === p);
  if (matches.length !== 1) return passthrough();
  const n = matches[0];
  try {
    const result = await ws.repo_locks(
      [n, ...(ws.repos[n].parent ? [ws.repos[n].parent] : [])],
      () => push(ws, n, globalArgs, args, identity()),
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    return result.exitCode ?? 0;
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    process.stderr.write("wb git: " + e.message + "\n");
    return e.code;
  }
}
