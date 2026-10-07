import {
  fs,
  path,
  env,
  Failure,
  digest,
  git,
  run,
  write_json,
  readJSON,
  read,
  hash,
  file,
  dir,
  symlink,
  exists,
  walk,
  list,
  resolve,
  within,
  equal,
  sortedJSON,
} from "./common.mjs";
export function catalog() {
  const value = readJSON(env.WB_BUILD_TARGETS);
  if (value.schemaVersion !== 1)
    throw new Failure("unsupported build target schema", 2);
  return value;
}
export function target(name) {
  const value = catalog().targets[name];
  if (!value) throw new Failure("unknown build target: " + name, 2);
  return value;
}
export function plan(ws, name, configuration = "release", mode = "release") {
  const contract = target(name);
  if (!contract.configurations.includes(configuration))
    throw new Failure("unsupported build configuration", 2);
  const records = ws.status(contract.repositories),
    result = {
      schemaVersion: 1,
      target: name,
      configuration,
      mode,
      contract,
      sources: records,
      lockSha256: digest(path.join(ws.root, "devenv.lock")),
      available: contract.backend === "nix",
      externalStep:
        contract.backend === "nix"
          ? null
          : contract.reason ||
            (contract.backend === "devbox"
              ? "Stage 4 devbox build backend is unavailable; no Windows execution was attempted"
              : null),
    };
  if (contract.availability === "development-only" && mode !== "development")
    Object.assign(result, { available: false, externalStep: contract.reason });
  if (contract.backend !== "nix" && records.every((r) => r.present)) {
    const request = {
        system: env.WB_SYSTEM,
        target: name,
        configuration,
        sources: Object.fromEntries(
          records.map((r) => [r.repository, { path: r.path }]),
        ),
      },
      expression =
        'import (builtins.toPath (builtins.getEnv "WB_DISPATCH_EXPRESSION")) { nixpkgsPath = builtins.getEnv "WB_NIXPKGS"; request = builtins.getEnv "WB_DISPATCH_REQUEST"; }';
    result.dispatch = JSON.parse(
      run([env.WB_NIX, "eval", "--impure", "--json", "--expr", expression], {
        env: { ...env, WB_DISPATCH_REQUEST: JSON.stringify(request) },
      }).stdout,
    );
    if (result.dispatch.backendAvailable)
      Object.assign(result, {
        available: true,
        externalStep:
          "A verified named guest and complete observed Windows inputs are required",
      });
  }
  return result;
}
export function selected_gitlinks(ws, component) {
  const c = ws.repos[component].submodules,
    paths = new Set(c.paths);
  for (const item of c.nested ?? []) paths.add(item.parent + "/" + item.path);
  for (const [n, r] of Object.entries(ws.repos))
    if (r.parent === component && c.paths.includes(r.submodulePath))
      for (const child of selected_gitlinks(ws, n))
        paths.add(r.submodulePath + "/" + child);
  return paths;
}
export function _copy_source(source, destination, boundary) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (symlink(source)) {
    const link = fs.readlinkSync(source),
      resolved = resolve(path.resolve(path.dirname(destination), link));
    if (path.isAbsolute(link) || !within(resolved, boundary))
      throw new Failure("source symlink escapes the exported snapshot", 1, {
        source,
      });
    fs.symlinkSync(link, destination);
  } else {
    fs.copyFileSync(source, destination);
    const s = fs.statSync(source);
    fs.chmodSync(destination, s.mode);
    fs.utimesSync(destination, s.atime, s.mtime);
  }
}
export function _export(
  p,
  destination,
  mode,
  expected = null,
  gitlinks = new Set(),
) {
  const head = git(p, "rev-parse", "HEAD").stdout.trim();
  if (expected && mode === "release" && head !== expected)
    throw new Failure("release source differs from its declared pin", 1, {
      source: p,
      expected,
      observed: head,
    });
  const diff = git(
      p,
      "diff",
      "--binary",
      "--ignore-submodules=all",
      "HEAD",
    ).stdout,
    untracked = git(p, "ls-files", "--others", "--exclude-standard", "-z")
      .stdout.split("\0")
      .filter(Boolean),
    conflicts = git(p, "ls-files", "-u").stdout;
  if (conflicts || (mode === "release" && (diff || untracked.length)))
    throw new Failure("release build requires a clean source snapshot", 1, {
      source: p,
      mode,
    });
  fs.mkdirSync(destination, { recursive: true });
  const children = [];
  for (const record of git(p, "ls-files", "--stage", "-z")
    .stdout.split("\0")
    .filter(Boolean)) {
    const at = record.indexOf("\t"),
      [filemode, oid] = record.slice(0, at).split(" "),
      name = record.slice(at + 1);
    if (path.isAbsolute(name) || name.split("/").includes(".."))
      throw new Failure("invalid source path", 2);
    const source = path.join(p, name),
      dest = path.join(destination, name);
    if (filemode === "160000") {
      if (gitlinks.has(name)) {
        if (!exists(path.join(source, ".git")))
          throw new Failure(
            "required shader/header gitlink is uninitialized",
            1,
            { source, revision: oid },
          );
        const selected = new Set(
          [...gitlinks]
            .filter((i) => i.startsWith(name + "/"))
            .map((i) => i.slice(name.length + 1)),
        );
        children.push({
          path: name,
          ..._export(source, dest, mode, oid, selected),
        });
      } else children.push({ path: name, revision: oid, materialized: false });
      continue;
    }
    if (!exists(source) && !symlink(source)) continue;
    _copy_source(source, dest, destination);
    if (mode === "release") {
      const content = symlink(dest)
          ? Buffer.from(fs.readlinkSync(dest))
          : fs.readFileSync(dest),
        blob = hash(
          Buffer.concat([
            Buffer.from("blob " + content.length + "\0"),
            content,
          ]),
          "sha1",
        );
      if (blob !== oid) {
        const filtered = !symlink(dest)
          ? git(p, "hash-object", "--path=" + name, "--", dest).stdout.trim()
          : blob;
        if (filtered !== oid)
          throw new Failure(
            "source changed while exporting a release snapshot",
            1,
            { source },
          );
      }
    }
  }
  for (const name of untracked)
    _copy_source(path.join(p, name), path.join(destination, name), destination);
  if (
    git(p, "rev-parse", "HEAD").stdout.trim() !== head ||
    git(p, "diff", "--binary", "--ignore-submodules=all", "HEAD").stdout !==
      diff ||
    !equal(
      git(p, "ls-files", "--others", "--exclude-standard", "-z")
        .stdout.split("\0")
        .filter(Boolean),
      untracked,
    )
  )
    throw new Failure(
      "source changed during snapshot export; retry explicitly",
      1,
      { source: p },
    );
  for (const n of untracked) {
    const source = path.join(p, n),
      exported = path.join(destination, n);
    if (
      symlink(source) !== symlink(exported) ||
      (symlink(source)
        ? fs.readlinkSync(source) !== fs.readlinkSync(exported)
        : digest(source) !== digest(exported))
    )
      throw new Failure("untracked source changed during snapshot export", 1, {
        source,
      });
  }
  write_json(path.join(destination, ".wb-source.json"), {
    revision: head,
    gitlinks: children,
  });
  fs.writeFileSync(
    path.join(destination, ".wb-revision"),
    head.slice(0, 8) + "\n",
  );
  const hashes = walk(destination)
    .filter((p) => file(p) && path.basename(p) !== ".wb-source.json")
    .map((p) => ({ path: path.relative(destination, p), sha256: digest(p) }));
  return {
    revision: head,
    diffSha256:
      diff || untracked.length
        ? hash(
            diff + sortedJSON(hashes.filter((f) => untracked.includes(f.path))),
          )
        : null,
    snapshotSha256: hash(sortedJSON(hashes)),
    gitlinks: children,
    untracked,
  };
}
export function _files(root) {
  return walk(root).flatMap((p) => {
    if (
      symlink(p) &&
      !within(resolve(p), resolve(root)) &&
      !resolve(p).startsWith("/nix/store/")
    )
      throw new Failure(
        "artifact links must reference the export or immutable Nix closure",
        1,
        { artifact: p },
      );
    if (file(p))
      return [
        {
          path: path.relative(root, p),
          sha256: digest(p),
          size: fs.statSync(p).size,
          ...(symlink(p) ? { linkTarget: fs.readlinkSync(p) } : {}),
        },
      ];
    if (symlink(p)) {
      if (!dir(p))
        throw new Failure("broken artifact symlink", 1, { artifact: p });
      return [
        {
          path: path.relative(root, p),
          type: "directorySymlink",
          linkTarget: fs.readlinkSync(p),
        },
      ];
    }
    return [];
  });
}
export function msvc_inputs(ws) {
  const lock = path.join(ws.root, "config/provision.lock.json"),
    lockHash = digest(lock),
    definition = readJSON(lock),
    ewdk = definition.tools.find((t) => t.sourceKind === "self-contained-ewdk"),
    payload = ewdk.payloads[0];
  const store = run([
    env.WB_NIX,
    "eval",
    "--raw",
    "--expr",
    "builtins.storeDir",
  ]).stdout.trim();
  let selected = null;
  for (const candidate of list(store).filter((p) =>
    p.endsWith("-winboat-windows-payloads"),
  )) {
    const receipt = path.join(candidate, "provision.lock.json"),
      archive = path.join(
        candidate,
        "files",
        payload.sha256 + "-" + payload.file,
      );
    if (file(receipt) && digest(receipt) === lockHash && file(archive)) {
      run([env.WB_NIX, "path-info", candidate]);
      selected = candidate;
      break;
    }
  }
  return { lockFile: lock, lockSha256: lockHash, payloads: selected };
}
export async function execute(
  ws,
  name,
  configuration,
  mode,
  operationId,
  devboxName = "default",
) {
  try {
    if (target(name).backend === "devbox")
      return await (
        await import("./windows.mjs")
      ).build(ws, devboxName, name, configuration, mode, operationId);
    return await _execute(ws, name, configuration, mode, operationId);
  } catch (e) {
    const p = path.join(ws.state, "operations", operationId + ".json"),
      receipt = exists(p) ? readJSON(p) : { kind: "build", target: name };
    Object.assign(receipt, {
      state: "failed",
      error: e.message,
      exitCode: e.code && Number.isInteger(e.code) ? e.code : 1,
    });
    ws.journal(operationId, receipt);
    throw e;
  }
}
export async function _execute(ws, name, configuration, mode, operationId) {
  const selection = plan(ws, name, configuration, mode),
    contract = selection.contract;
  if (!selection.available)
    throw new Failure(selection.externalStep, 3, {
      plan: selection,
      backend: contract.backend,
    });
  if (env.WB_SYSTEM !== "x86_64-linux")
    throw new Failure(
      "initial build acceptance requires an x86_64 Linux host",
      3,
    );
  const directory = path.join(ws.state, "builds", operationId);
  fs.mkdirSync(directory, { recursive: true });
  const sourceRecords = {};
  await ws.repo_locks(contract.repositories, () => {
    for (const component of contract.repositories) {
      const p = ws.validate_checkout(component),
        exported = path.join(directory, "sources", component),
        id = _export(
          p,
          exported,
          mode,
          ws.repos[component].pin.rev,
          ["dxvk", "vkd3d-proton", "dxil-spirv", "clvk-helios"].includes(
            component,
          )
            ? selected_gitlinks(ws, component)
            : new Set(),
        );
      sourceRecords[component] = {
        path: exported,
        canonicalUrl: ws.repos[component].url,
        declaredPin: ws.repos[component].pin.rev,
        ...id,
        narHash: run([
          env.WB_NIX,
          "hash",
          "path",
          "--sri",
          exported,
        ]).stdout.trim(),
      };
    }
  });
  const specification = {
    schemaVersion: 1,
    target: name,
    configuration,
    system: env.WB_SYSTEM,
    sources: sourceRecords,
  };
  if (contract.toolchain === "linux-msvc-cross")
    specification.msvc = msvc_inputs(ws);
  const specPath = path.join(directory, "specification.json");
  write_json(specPath, specification);
  const receipt = {
    kind: "build",
    state: "building",
    target: name,
    specification: specPath,
    log: path.join(directory, "build.log"),
    mode,
    configuration,
  };
  ws.journal(operationId, receipt);
  const expression = env.WB_BUILD_EXPRESSION,
    argv = [
      env.WB_NIX,
      "build",
      "--json",
      "--out-link",
      path.join(directory, "result"),
      "--print-build-logs",
      "--file",
      expression,
      "--argstr",
      "nixpkgsPath",
      env.WB_NIXPKGS,
      "--argstr",
      "specification",
      specPath,
    ];
  if (specification.msvc) argv.push("--impure");
  const log = fs.openSync(receipt.log, "w");
  let proc;
  try {
    proc = run(argv, { stderr: log, check: false });
  } finally {
    fs.closeSync(log);
  }
  if (proc.returncode) {
    Object.assign(receipt, { state: "failed", exitCode: proc.returncode });
    ws.journal(operationId, receipt);
    throw new Failure(
      "Nix component build failed; inspect the retained build log",
      proc.returncode,
      {
        receipt: path.join(ws.state, "operations", operationId + ".json"),
        log: receipt.log,
      },
    );
  }
  const built = JSON.parse(proc.stdout),
    output = built[0].outputs.out,
    exported = path.join(
      ws.out,
      contract.abi.startsWith("windows") ? "guest" : "native",
      operationId,
    );
  fs.mkdirSync(exported, { recursive: true });
  fs.cpSync(output, path.join(exported, "files"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  const files = _files(path.join(exported, "files")),
    licenses = files
      .filter((f) => f.path.includes("licenses/"))
      .map((f) => f.path),
    symbols = files
      .filter(
        (f) =>
          f.sha256 && (f.path.includes("/debug/") || f.path.endsWith(".pdb")),
      )
      .map((f) => f.path);
  if (!licenses.length)
    throw new Failure("artifact output lacks retained licenses", 1, {
      artifact: exported,
    });
  const provenance = JSON.parse(
    run([env.WB_NIX, "derivation", "show", "--recursive", built[0].drvPath])
      .stdout,
  );
  write_json(path.join(directory, "derivations.json"), provenance);
  const manifest = {
    schemaVersion: 1,
    artifactId: operationId,
    target: name,
    abi: contract.abi,
    configuration,
    mode,
    sources: Object.fromEntries(
      Object.entries(sourceRecords).map(([k, v]) => [
        k,
        Object.fromEntries(Object.entries(v).filter(([k]) => k !== "path")),
      ]),
    ),
    dependencies: Object.fromEntries(
      Object.entries(sourceRecords).map(([k, v]) => [k, v.revision]),
    ),
    toolchain: {
      nixpkgs: env.WB_NIXPKGS,
      lockSha256: selection.lockSha256,
      derivations: Object.keys(provenance).sort(),
    },
    recipe: {
      expression,
      rootRevision: git(ws.root, "rev-parse", "HEAD").stdout.trim(),
      sharedOperationsNarHash: run([
        env.WB_NIX,
        "hash",
        "path",
        "--sri",
        path.dirname(expression),
      ]).stdout.trim(),
      controlPlaneStorePath: env.WB_OPERATION_SOURCES,
      rootDiffSha256: hash(git(ws.root, "diff", "--binary", "HEAD").stdout),
    },
    outputs: built,
    files,
    licenses,
    symbols,
    embeddedSymbols: name === "dxvk-win64",
    provenance: {
      operationId,
      derivations: path.join(directory, "derivations.json"),
    },
    state: "built",
    installed: false,
    loaded: false,
  };
  const images = [];
  for (const f of files) {
    const image = path.join(exported, "files", f.path);
    if (!file(image)) continue;
    const fd = fs.openSync(image, "r"),
      magic = Buffer.alloc(4);
    try {
      fs.readSync(fd, magic, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (magic.subarray(0, 2).toString() === "MZ") {
      const headers = run([env.WB_OBJDUMP, "-p", image]).stdout,
        sections = run([env.WB_OBJDUMP, "-h", image]).stdout;
      images.push({
        path: f.path,
        format: "PE",
        headers,
        sections,
        embeddedDebug: sections.includes(".debug_info"),
      });
      if (
        name === "dxvk-win64" &&
        (!headers.toLowerCase().includes("pei-x86-64") ||
          [
            "vcruntime",
            "msvcp",
            "libgcc_s",
            "libstdc++",
            "libwinpthread",
            "mcfgthread",
          ].some((l) => headers.toLowerCase().includes(l)))
      )
        throw new Failure(
          "cross artifact architecture/CRT imports violate the target contract",
          1,
          { artifact: image },
        );
    } else if (magic.equals(Buffer.from([127, 69, 76, 70])))
      images.push({
        path: f.path,
        format: "ELF",
        headers: run([env.WB_READELF, "-h", "-n", "-d", image]).stdout,
      });
  }
  manifest.images = images;
  if (contract.toolchain === "linux-msvc-cross") {
    const inspectionPath = path.join(exported, "files/images.json"),
      inspectionFile = files.find((f) => f.path === "images.json");
    if (!inspectionFile)
      throw new Failure("cross artifact lacks its image inspection file", 74);
    // Retain the full per-object COFF report in the hashed artifact file;
    // copying it into metadata made real engine manifests exceed 50 MiB.
    const inspections = readJSON(inspectionPath).map(
        ({ inspection, ...record }) => ({
          ...record,
          inspectionFile,
        }),
      ),
      indexed = Object.fromEntries(inspections.map((i) => [i.path, i]));
    for (const i of images)
      if (i.format === "PE") {
        if (!indexed[i.path])
          throw new Failure(
            "cross artifact lacks its architecture/static CRT inspection",
            1,
            { artifact: i.path },
          );
        Object.assign(i, indexed[i.path]);
      }
    images.push(...inspections.filter((i) => i.format === "COFF archive"));
    manifest.embeddedSymbols = images.some((i) => i.embeddedCodeView);
    manifest.toolchain.msvc = specification.msvc;
  }
  manifest.closure = JSON.parse(
    run([env.WB_NIX, "path-info", "--recursive", "--json", output]).stdout,
  );
  const manifestPath = path.join(exported, "manifest.json");
  write_json(manifestPath, manifest);
  for (const p of walk(exported))
    if (file(p) && !symlink(p)) fs.chmodSync(p, fs.statSync(p).mode & ~0o222);
  fs.chmodSync(manifestPath, 0o444);
  Object.assign(receipt, {
    state: "succeeded",
    exitCode: 0,
    manifest: manifestPath,
    manifestSha256: digest(manifestPath),
    outputs: built,
    artifactDirectory: exported,
  });
  ws.journal(operationId, receipt);
  return receipt;
}
export function verify(p) {
  p = resolve(p);
  const manifest = readJSON(p);
  if (manifest.schemaVersion !== 1 || manifest.state !== "built")
    throw new Failure("unsupported artifact manifest", 2);
  if (
    !manifest.files?.length ||
    !equal(_files(path.join(path.dirname(p), "files")), manifest.files)
  )
    throw new Failure("artifact hashes/file set differ from the manifest", 1, {
      manifest: p,
    });
  return {
    state: "verified",
    manifest: p,
    manifestSha256: digest(p),
    artifactId: manifest.artifactId,
    filesVerified: manifest.files.length,
    installed: false,
    loaded: false,
  };
}
