import {
  fs,
  path,
  env,
  Failure,
  git,
  locks,
  parse_pins,
  valid_ref,
  valid_sha,
  write_json,
  resolve,
  within,
  file,
  exists,
  readJSON,
  read,
} from "./common.mjs";
export function discover(explicit) {
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  else {
    let p = resolve(process.cwd());
    for (;;) {
      candidates.push(p);
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
    }
    if (env.WB_WORKSPACE_ROOT) candidates.push(resolve(env.WB_WORKSPACE_ROOT));
  }
  for (const p of candidates)
    if (
      file(path.join(p, "nix/repositories.nix")) &&
      file(path.join(p, "devenv.nix"))
    )
      return p;
  throw new Failure("workspace not found; pass --workspace <root>", 2);
}
export function merge(base, override) {
  const result = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (["__proto__", "constructor", "prototype"].includes(k))
      throw new Failure("invalid configuration key", 2);
    result[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      result[k] &&
      typeof result[k] === "object" &&
      !Array.isArray(result[k])
        ? merge(result[k], v)
        : v;
  }
  return result;
}
export class Workspace {
  constructor(root, invocation = {}) {
    this.root = resolve(root);
    this.config = readJSON(path.join(this.root, "config/defaults.json"));
    const local = path.join(this.root, "local.json");
    if (exists(local)) {
      const o = readJSON(local);
      if (
        o.schemaVersion !== 1 ||
        Object.keys(o).some(
          (k) => !["schemaVersion", "workspace", "devbox"].includes(k),
        )
      )
        throw new Failure(
          "unknown local configuration field or schemaVersion",
          2,
        );
      this.config = merge(this.config, o);
    }
    if (env.WB_INVOCATION_PATHS)
      this.config = merge(this.config, {
        workspace: JSON.parse(env.WB_INVOCATION_PATHS),
      });
    this.config = merge(this.config, { workspace: invocation });
    const s = this.config.workspace,
      allowed = [
        "repositoriesRoot",
        "stateRoot",
        "outRoot",
        "repositoryOverrides",
        "remotes",
        "forkNamespace",
        "gitTransport",
      ];
    if (Object.keys(s).some((k) => !allowed.includes(k)))
      throw new Failure("unknown workspace configuration field", 2);
    if (!["https", "ssh"].includes(s.gitTransport))
      throw new Failure("gitTransport must be https or ssh", 2);
    if (
      s.forkNamespace != null &&
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(s.forkNamespace)
    )
      throw new Failure("invalid forkNamespace", 2);
    this.state = this.resolve(s.stateRoot);
    this.out = this.resolve(s.outRoot);
    this.repo_root = this.resolve(s.repositoriesRoot);
    const locations = [this.state, this.out, this.repo_root];
    if (locations.some((p) => within(this.root, p)))
      throw new Failure("output locations cannot contain the workspace", 2);
    for (let i = 0; i < locations.length; i++)
      for (let j = i + 1; j < locations.length; j++)
        if (
          within(locations[i], locations[j]) ||
          within(locations[j], locations[i])
        )
          throw new Failure(
            "repository/state/output locations must be disjoint",
            2,
          );
    this.manifest = readJSON(env.WB_MANIFEST_FILE);
    if (this.manifest.schemaVersion !== 1 || this.manifest.layoutVersion !== 1)
      throw new Failure("unsupported repository layout/schema", 2);
    this.repos = structuredClone(this.manifest.repositories);
    this.pins_path = path.join(this.root, "nix/pins.nix");
    this.refresh();
    const overrides = s.repositoryOverrides;
    if (
      !overrides ||
      Array.isArray(overrides) ||
      !s.remotes ||
      Array.isArray(s.remotes) ||
      typeof overrides !== "object" ||
      typeof s.remotes !== "object"
    )
      throw new Failure("repositoryOverrides/remotes must be objects", 2);
    if (
      [...Object.keys(overrides), ...Object.keys(s.remotes)].some(
        (n) => !Object.hasOwn(this.repos, n),
      )
    )
      throw new Failure("unknown repository override", 2);
    this.paths = {};
    for (const name of this.order(Object.keys(this.repos))) {
      const repo = this.repos[name],
        override = overrides[name];
      let p;
      if (override != null) {
        if (
          typeof override !== "object" ||
          Object.keys(override).some(
            (k) => !["path", "adopt", "readOnly"].includes(k),
          ) ||
          override.adopt !== true
        )
          throw new Failure(
            "repositoryOverrides require explicit path/adopt: true",
            2,
          );
        p = this.resolve(override.path);
        repo.readOnly = override.readOnly ?? false;
      } else
        p = repo.parent
          ? path.join(this.paths[repo.parent], repo.submodulePath)
          : path.join(this.repo_root, repo.path.slice("repos/".length));
      if (repo.parent && this.repos[repo.parent].readOnly) repo.readOnly = true;
      if (within(this.root, p) || within(p, this.state))
        throw new Failure("invalid repository location: " + name, 2);
      this.paths[name] = resolve(p);
      repo.fetchUrl = s.remotes[name] ?? (repo.pin.sourceUrl || repo.url);
      if (
        typeof repo.fetchUrl !== "string" ||
        !repo.fetchUrl ||
        /^-/.test(repo.fetchUrl) ||
        /[\n\0]/.test(repo.fetchUrl)
      )
        throw new Failure("invalid repository URL", 2);
    }
    if (
      new Set(Object.values(this.paths)).size !== Object.keys(this.paths).length
    )
      throw new Failure("duplicate writable repository location", 2);
    for (const [n, r] of Object.entries(this.repos))
      if (
        r.parent &&
        this.paths[n] !== path.join(this.paths[r.parent], r.submodulePath)
      )
        throw new Failure(
          "nested override must retain the declared parent layout: " + n,
          2,
        );
  }
  resolve(value) {
    if (typeof value !== "string" || !value)
      throw new Failure("path overrides must be nonempty strings", 2);
    return resolve(
      value.startsWith("~/") ? value : path.resolve(this.root, value),
    );
  }
  refresh() {
    const pins = parse_pins(read(this.pins_path)).repositories;
    if (
      Object.keys(pins).sort().join() !== Object.keys(this.repos).sort().join()
    )
      throw new Failure("pins and repository inventory differ", 2);
    for (const [n, p] of Object.entries(pins)) {
      if (p.rev !== null && !valid_sha(p.rev))
        throw new Failure("invalid revision: " + n, 2);
      if (p.ref !== null && !valid_ref(p.ref))
        throw new Failure("invalid development ref: " + n, 2);
      this.repos[n].pin = p;
    }
  }
  select(args) {
    const selected = new Set();
    if (args.subset) {
      const subset =
        args.subset === "all"
          ? Object.keys(this.repos)
          : this.manifest.subsets[args.subset];
      if (!subset) throw new Failure("unknown subset: " + args.subset, 2);
      subset.forEach((n) => selected.add(n));
    }
    for (let n of args.repo ?? []) {
      if (n === "clkvk-helios") n = "clvk-helios";
      if (!Object.hasOwn(this.repos, n))
        throw new Failure("unknown repository: " + n, 2);
      selected.add(n);
    }
    if (!selected.size) Object.keys(this.repos).forEach((n) => selected.add(n));
    for (const n of selected)
      this.repos[n].dependencies.forEach((d) => selected.add(d));
    const containers = new Set();
    for (const n of selected) {
      let parent = this.repos[n].parent;
      while (parent) {
        if (!selected.has(parent)) containers.add(parent);
        parent = this.repos[parent].parent;
      }
    }
    return [[...selected].sort(), [...containers].sort()];
  }
  order(names, children_first = false) {
    names = new Set(names);
    const depth = (n) =>
      this.repos[n].parent ? 1 + depth(this.repos[n].parent) : 0;
    if (!children_first)
      return [...names].sort(
        (a, b) => depth(a) - depth(b) || a.localeCompare(b, "en"),
      );
    const result = [],
      visiting = new Set(),
      visited = new Set();
    const visit = (n) => {
      if (visiting.has(n))
        throw new Failure("cyclic publication dependencies", 2);
      if (visited.has(n)) return;
      visiting.add(n);
      const deps = new Set([
        ...this.repos[n].dependencies,
        ...Object.keys(this.repos).filter((c) => this.repos[c].parent === n),
      ]);
      for (const d of [...deps].sort()) if (names.has(d)) visit(d);
      visiting.delete(n);
      visited.add(n);
      result.push(n);
    };
    [...names].sort().forEach(visit);
    return result;
  }
  exists(n) {
    const p = this.paths[n];
    if (!exists(path.join(p, ".git"))) return false;
    const proc = git(p, "rev-parse", "--show-toplevel", { check: false });
    return !proc.returncode && resolve(proc.stdout.trim()) === p;
  }
  validate_checkout(n, mutable = false) {
    const r = this.repos[n],
      p = this.paths[n];
    if (mutable && r.readOnly)
      throw new Failure("read-only adopted reference: " + n);
    if (!this.exists(n)) throw new Failure("checkout missing: " + n);
    if (fs.statSync(p).uid !== process.getuid())
      throw new Failure("checkout is not owned by the current user: " + n);
    const urls = git(p, "config", "--get-regexp", "^remote\\..*\\.url$", {
      check: false,
    })
      .stdout.trim()
      .split("\n")
      .map((l) => l.replace(/^\S+\s+/, ""));
    if (!urls.some((u) => u === r.url || u === r.fetchUrl))
      throw new Failure("checkout identity/remotes do not match: " + n);
    return p;
  }
  status(names) {
    return names.map((n) => {
      const p = this.paths[n],
        present = this.exists(n);
      return {
        repository: n,
        path: p,
        pin: this.repos[n].pin,
        present,
        ...(present
          ? {
              head: git(p, "rev-parse", "HEAD").stdout.trim(),
              changes: git(
                p,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              )
                .stdout.split("\n")
                .filter(Boolean),
              branch:
                git(p, "symbolic-ref", "-q", "HEAD", {
                  check: false,
                }).stdout.trim() || null,
            }
          : {}),
      };
    });
  }
  repo_locks(names, callback) {
    return locks(
      [...names].map((n) => path.join(this.state, "locks", n + ".lock")),
      callback,
    );
  }
  journal(operationId, data) {
    const p = path.join(this.state, "operations", operationId + ".json");
    write_json(p, { schemaVersion: 1, operationId, ...data });
    return p;
  }
}
