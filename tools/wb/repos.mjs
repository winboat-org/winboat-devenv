import {
  fs,
  path,
  env,
  Failure,
  git,
  run,
  write_json,
  hash,
  exists,
  list,
  now,
} from "./common.mjs";
export function clean(ws, name, ignore_children = false) {
  if (!ws.exists(name)) {
    if (list(ws.paths[name]).length)
      throw new Failure("nonempty unmanaged checkout path: " + ws.paths[name]);
    return;
  }
  const p = ws.validate_checkout(name, true),
    args = ["status", "--porcelain=v1", "--untracked-files=all"];
  if (ignore_children) args.push("--ignore-submodules=all");
  const changes = git(p, ...args).stdout;
  if (changes)
    throw new Failure(
      "sync refuses dirty/staged/untracked/conflicted checkout: " + name,
      1,
      {
        changes: changes.trimEnd().split("\n"),
        remedy: "checkpoint selected paths or resolve work explicitly",
      },
    );
  const head = git(p, "rev-parse", "HEAD").stdout.trim();
  if (
    !git(p, "symbolic-ref", "-q", "HEAD", { check: false }).returncode &&
    head !== ws.repos[name].pin.rev
  )
    throw new Failure("development branch differs from pin: " + name, 1, {
      remedy: "publish/checkpoint it, or explicitly detach before sync",
    });
}
export function cache_object(ws, name, rev, url, refresh = false) {
  const repo = ws.repos[name];
  rev ||= repo.pin.rev;
  url ||= repo.fetchUrl;
  if (!rev) throw new Failure("unresolved source pin: " + name);
  const cache = path.join(
    ws.state,
    "source-cache",
    name + "-" + hash(url).slice(0, 16) + ".git",
  );
  if (!exists(cache)) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    run([env.WB_REAL_GIT, "init", "--bare", cache]);
  }
  if (
    git(cache, "cat-file", "-e", rev + "^{commit}", { check: false })
      .returncode ||
    refresh
  ) {
    process.stderr.write("Fetching exact source object for " + name + "\n");
    git(cache, "fetch", "--no-tags", "--depth=1", url, rev);
  }
  if (git(cache, "rev-parse", rev + "^{commit}").stdout.trim() !== rev)
    throw new Failure("source object identity differs: " + name);
  return cache;
}
export function gitlink(p, rev, subpath) {
  const l = git(p, "ls-tree", rev, "--", subpath).stdout.trim();
  if (!l.startsWith("160000 commit "))
    throw new Failure("missing parent gitlink: " + subpath);
  return l.split(/\s+/)[2];
}
export function module_names(p, rev) {
  const r = git(p, "show", rev + ":.gitmodules", { check: false });
  if (r.returncode) return {};
  const parsed = run(
    [
      env.WB_REAL_GIT,
      "config",
      "--file",
      "-",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    { input: r.stdout, check: false },
  );
  return Object.fromEntries(
    parsed.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^(\S+)\s+(.*)$/);
        return [m[2], m[1].slice(10, -5)];
      }),
  );
}
export function plan(ws, selected, containers) {
  const records = ws.order([...selected, ...containers]).map((name) => {
    const repo = ws.repos[name],
      p = ws.paths[name],
      present = ws.exists(name),
      head = present ? git(p, "rev-parse", "HEAD").stdout.trim() : null,
      change = !present || head !== repo.pin.rev;
    return {
      repository: name,
      containerOnly: containers.includes(name),
      path: p,
      revision: repo.pin.rev,
      action: !present ? "clone" : change ? "checkout" : "retain",
      writes: change ? [p] : [],
      submoduleConfigWrites:
        !present && repo.parent
          ? path.join(ws.paths[repo.parent], ".git")
          : null,
    };
  });
  return {
    selected,
    containers,
    repositories: records,
    stateWrites: ["source-cache", "operations", "locks"].map((n) =>
      path.join(ws.state, n),
    ),
    submodules: Object.fromEntries(
      selected.map((n) => [n, ws.repos[n].submodules.paths]),
    ),
    developmentBranch: "wb repo branch --repo <id> [--name <branch>]",
  };
}
export async function sync(ws, selected, containers, operationId) {
  const scope = [...new Set([...selected, ...containers])],
    result = plan(ws, selected, containers);
  return ws.repo_locks(scope, () => {
    for (const name of scope) {
      const repo = ws.repos[name],
        p = ws.paths[name],
        target = repo.pin.rev;
      if (!target) throw new Failure("unresolved source pin: " + name);
      if (containers.includes(name) && ws.exists(name)) {
        ws.validate_checkout(name);
        if (git(p, "rev-parse", "HEAD").stdout.trim() === target) continue;
      }
      clean(ws, name, true);
      if (ws.exists(name)) {
        const managed = new Set(
          Object.values(ws.repos)
            .filter((r) => r.parent === name)
            .map((r) => r.submodulePath),
        );
        for (const subpath of repo.submodules.paths)
          if (
            !managed.has(subpath) &&
            exists(path.join(p, subpath, ".git")) &&
            git(
              path.join(p, subpath),
              "status",
              "--porcelain",
              "--untracked-files=all",
            ).stdout
          )
            throw new Failure(
              "dirty selected third-party submodule: " + name + ":" + subpath,
            );
        for (const module of repo.submodules.nested ?? []) {
          const nested = path.join(p, module.parent, module.path);
          if (
            exists(path.join(nested, ".git")) &&
            git(nested, "status", "--porcelain", "--untracked-files=all").stdout
          )
            throw new Failure(
              "dirty selected nested shader submodule: " + nested,
            );
        }
        if (
          git(p, "rev-parse", "HEAD").stdout.trim() !== target &&
          git(p, "status", "--porcelain", "--untracked-files=all").stdout
        )
          throw new Failure(
            "parent checkout change would affect dirty submodule state: " +
              name,
          );
      }
    }
    const caches = Object.fromEntries(
      ws.order(scope).map((n) => [n, cache_object(ws, n)]),
    );
    for (const n of scope) {
      const r = ws.repos[n];
      if (
        r.parent &&
        gitlink(
          caches[r.parent],
          ws.repos[r.parent].pin.rev,
          r.submodulePath,
        ) !== r.pin.rev
      )
        throw new Failure("pin disagrees with parent gitlink: " + n, 1, {
          remedy: "make an explicit coherent parent/pin update",
        });
    }
    const receipt = {
      kind: "sync",
      state: "running",
      ...result,
      completed: [],
    };
    ws.journal(operationId, receipt);
    try {
      for (const n of ws.order(scope)) {
        const r = ws.repos[n],
          p = ws.paths[n];
        if (!ws.exists(n)) {
          fs.mkdirSync(p, { recursive: true });
          git(p, "init");
          git(p, "remote", "add", "origin", r.fetchUrl);
          git(p, "fetch", "--no-tags", caches[n], r.pin.rev);
          git(
            p,
            "-c",
            "submodule.recurse=false",
            "checkout",
            "--detach",
            r.pin.rev,
          );
          if (r.parent) {
            const module = module_names(ws.paths[r.parent], "HEAD")[
              r.submodulePath
            ];
            if (!module)
              throw new Failure("missing selected .gitmodules path: " + n);
            git(
              ws.paths[r.parent],
              "config",
              "submodule." + module + ".url",
              r.fetchUrl,
            );
            git(
              ws.paths[r.parent],
              "submodule",
              "absorbgitdirs",
              "--",
              r.submodulePath,
            );
          }
        } else if (git(p, "rev-parse", "HEAD").stdout.trim() !== r.pin.rev) {
          git(p, "fetch", "--no-tags", caches[n], r.pin.rev);
          git(
            p,
            "-c",
            "submodule.recurse=false",
            "checkout",
            "--detach",
            r.pin.rev,
          );
        }
        if (selected.includes(n)) {
          const managed = new Set(
            Object.values(ws.repos)
              .filter((r) => r.parent === n)
              .map((r) => r.submodulePath),
          );
          const third = r.submodules.paths.filter((p) => !managed.has(p)),
            names = module_names(p, "HEAD");
          for (const sub of third) {
            if (!Object.hasOwn(names, sub))
              throw new Failure(
                "declared submodule missing at pin: " + n + ":" + sub,
              );
            if (
              exists(path.join(p, sub, ".git")) &&
              git(
                path.join(p, sub),
                "status",
                "--porcelain",
                "--untracked-files=all",
              ).stdout
            )
              throw new Failure("dirty selected third-party submodule: " + sub);
            git(
              p,
              "-c",
              "submodule.recurse=false",
              "submodule",
              "update",
              "--init",
              "--depth=1",
              "--",
              sub,
            );
          }
          for (const module of r.submodules.nested ?? []) {
            const parent = path.join(p, module.parent);
            if (
              !third.includes(module.parent) ||
              !Object.hasOwn(module_names(parent, "HEAD"), module.path)
            )
              throw new Failure(
                "nested shader module is outside the selected gitlink contract",
                2,
              );
            git(
              parent,
              "-c",
              "submodule.recurse=false",
              "submodule",
              "update",
              "--init",
              "--depth=1",
              "--",
              module.path,
            );
          }
        }
        receipt.completed.push(n);
        ws.journal(operationId, receipt);
      }
      receipt.state = "succeeded";
      ws.journal(operationId, receipt);
      return receipt;
    } catch (e) {
      Object.assign(receipt, { state: "failed", error: e.message });
      ws.journal(operationId, receipt);
      throw e;
    }
  });
}
export function branch(ws, selected, name) {
  if (selected.length !== 1)
    throw new Failure(
      "branch requires exactly one selected repository (without dependency closure)",
      2,
    );
  const n = selected[0],
    p = ws.validate_checkout(n, true);
  name ||= ws.repos[n].pin.ref;
  if (!name) throw new Failure("development ref unresolved; pass --name", 2);
  name = name.replace(/^refs\/heads\//, "");
  git(p, "check-ref-format", "--branch", name);
  git(p, "switch", "-c", name);
  return { repository: n, branch: name };
}
export async function fork(
  ws,
  selected,
  namespace,
  operationId,
  apply = false,
) {
  namespace ||= ws.config.workspace.forkNamespace;
  if (
    typeof namespace !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(namespace)
  )
    throw new Failure("fork requires a valid GitHub namespace", 2);
  const action = () => {
    const remotes = [];
    for (const n of selected) {
      const p = ws.validate_checkout(n, apply),
        r = ws.repos[n];
      if (
        git(p, "cat-file", "-e", r.pin.rev + "^{commit}", { check: false })
          .returncode
      )
        throw new Failure(
          "pinned object unavailable locally before fork: " + n,
          1,
          {
            remedy: "sync the exact pin from upstream before changing remotes",
          },
        );
      let url =
        ws.config.workspace.gitTransport === "https"
          ? `https://github.com/${namespace}/${n}.git`
          : `git@github.com:${namespace}/${n}.git`;
      const template = ws.config.workspace.remotes[n];
      if (template?.includes("{namespace}"))
        url = template.replaceAll("{namespace}", namespace);
      const probe = run([env.WB_REAL_GIT, "ls-remote", url], { check: false });
      if (probe.returncode)
        throw new Failure("fork unavailable: " + n, 1, {
          creation: "gh repo fork winboat-org/" + n + " --clone=false",
          diagnostic: probe.stderr.trim(),
        });
      const upstream = git(p, "config", "--get", "remote.upstream.url", {
        check: false,
      });
      if (!upstream.returncode && upstream.stdout.trim() !== r.url)
        throw new Failure(
          "upstream remote conflicts with canonical identity: " + n,
        );
      const origins = git(p, "config", "--get-all", "remote.origin.url")
          .stdout.trimEnd()
          .split("\n"),
        pushurls = git(p, "config", "--get-all", "remote.origin.pushurl", {
          check: false,
        }).stdout;
      if (origins.length !== 1 || pushurls)
        throw new Failure(
          "fork refuses multiple origin URLs/pushurl overrides: " + n,
        );
      remotes.push({
        repository: n,
        oldOrigin: origins[0],
        origin: url,
        upstream: r.url,
      });
    }
    const receipt = {
      kind: "fork",
      namespace,
      state: "planned",
      remotes,
      completed: [],
    };
    if (apply) {
      ws.journal(operationId, receipt);
      try {
        for (const change of remotes) {
          const n = change.repository,
            p = ws.paths[n];
          if (
            git(p, "remote", "get-url", "upstream", { check: false }).returncode
          )
            git(p, "remote", "add", "upstream", change.upstream);
          git(p, "remote", "set-url", "origin", change.origin);
          const parent = ws.repos[n].parent;
          if (parent && ws.exists(parent)) {
            const module = module_names(ws.paths[parent], "HEAD")[
              ws.repos[n].submodulePath
            ];
            if (module)
              git(
                ws.paths[parent],
                "config",
                "submodule." + module + ".url",
                change.origin,
              );
          }
          receipt.completed.push(n);
          ws.journal(operationId, receipt);
        }
        receipt.state = "succeeded";
        ws.journal(operationId, receipt);
      } catch (e) {
        Object.assign(receipt, { state: "partial", error: e.message });
        ws.journal(operationId, receipt);
        throw new Failure("fork partially applied; inspect receipt", 1, {
          receiptId: operationId,
        });
      }
    }
    return receipt;
  };
  return apply ? ws.repo_locks(selected, action) : action();
}
export function verify(ws, selected) {
  const records = [];
  for (const n of selected) {
    const r = ws.repos[n],
      { ref, rev } = r.pin,
      url = r.pin.sourceUrl || r.url;
    process.stderr.write("Verifying source/ref for " + n + "\n");
    const advertised = run([
        env.WB_REAL_GIT,
        "ls-remote",
        "--symref",
        url,
        "HEAD",
        "refs/heads/*",
      ]).stdout,
      cache = cache_object(ws, n, undefined, url, true);
    if (
      r.parent &&
      gitlink(
        cache_object(ws, r.parent, undefined, ws.repos[r.parent].url),
        ws.repos[r.parent].pin.rev,
        r.submodulePath,
      ) !== rev
    )
      throw new Failure("remote pin/gitlink mismatch: " + n);
    if (ref && !advertised.split("\n").some((l) => l.endsWith("\t" + ref)))
      throw new Failure("development ref unavailable: " + n);
    records.push({
      repository: n,
      canonicalUrl: r.url,
      sourceUrl: url,
      revision: rev,
      developmentRef: ref,
      objectVerified: true,
      advertisedRefs: advertised.trimEnd().split("\n"),
      timestamp: now(),
      cache,
    });
  }
  const evidence = path.join(ws.state, "verification/sources.json");
  write_json(evidence, { schemaVersion: 1, repositories: records });
  return { repositories: records, evidence };
}
