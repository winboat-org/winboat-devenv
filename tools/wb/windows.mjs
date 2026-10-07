import * as devbox from "./devbox.mjs";
import * as builds from "./builds.mjs";
import { create_zip, extract_artifact, windows_relative } from "./archives.mjs";
import {
  fs,
  path,
  env,
  Failure,
  digest,
  git,
  identity,
  locked,
  run,
  write_json,
  readJSON,
  read,
  list,
  walk,
  file,
  dir,
  symlink,
  exists,
  resolve,
  within,
  equal,
  hash,
  mkdir,
  sleep,
} from "./common.mjs";
export { extract_artifact, windows_relative };
export const ROOT = "C:\\ProgramData\\WinBoatDev";
export const PURPOSES = new Set(["build", "install", "desktop", "system"]);
export function literal(value) {
  if (String(value).includes("\0"))
    throw new Failure("NUL in PowerShell argument", 2);
  return "'" + String(value).replaceAll("'", "''") + "'";
}
export const encoded = (script) =>
  "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " +
  Buffer.from(script, "utf16le").toString("base64");
export function connection(ws, name) {
  const [directory, record] = devbox.load(ws, name);
  if (!file(path.join(directory, "known_hosts")))
    throw new Failure("guest SSH host key is not pinned", 3);
  return [directory, record];
}
export function invoke(ws, name, script, check = true, timeout = 120000) {
  const [directory, record] = connection(ws, name);
  let proc;
  try {
    proc = run([...devbox.ssh_command(directory, record), encoded(script)], {
      check: false,
      timeout,
    });
  } catch (e) {
    if (e.code === 75)
      throw new Failure(
        "Windows transport timed out; observe the durable task before retrying",
        75,
      );
    throw e;
  }
  if (check && proc.returncode)
    throw new Failure(
      proc.stderr.trim() || proc.stdout.trim() || "Windows transport failed",
      proc.returncode,
    );
  return proc;
}
export function remote_file(ws, name, p) {
  return JSON.parse(
    invoke(
      ws,
      name,
      "$ErrorActionPreference='Stop'; $p=" +
        literal(p) +
        "; $f=Get-Item -LiteralPath $p; @{sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower();size=$f.Length} | ConvertTo-Json -Compress",
    ).stdout.replace(/^\uFEFF/, ""),
  );
}
export function _sftp(ws, name, local, remote, direction) {
  const [directory, record] = connection(ws, name),
    quote = (v) => {
      v = String(v);
      if (/[\r\n\0]/.test(v)) throw new Failure("invalid SFTP path", 2);
      return '"' + v.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    };
  remote = remote.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(remote)) remote = "/" + remote;
  const batch =
      (direction === "upload"
        ? "put " + quote(local) + " " + quote(remote)
        : "get " + quote(remote) + " " + quote(local)) + "\n",
    args = devbox.ssh_command(directory, record);
  args[0] = env.WB_SFTP;
  args[args.indexOf("-p")] = "-P";
  args.splice(-1, 0, "-b", "-");
  const p = run(args, { input: batch, timeout: 600000, check: false });
  if (p.returncode)
    throw new Failure(p.stderr.trim() || "SFTP transfer failed", p.returncode);
}
export function upload(ws, name, local, remote) {
  const before = { sha256: digest(local), size: fs.statSync(local).size };
  _sftp(ws, name, local, remote, "upload");
  const after = remote_file(ws, name, remote);
  if (
    !equal(before, after) ||
    !equal(before, { sha256: digest(local), size: fs.statSync(local).size })
  )
    throw new Failure("upload hash/size mismatch; no task was started", 74, {
      expected: before,
      observed: after,
    });
  return { local, remote, ...after };
}
export function download(ws, name, remote, local, expected = null) {
  const before = remote_file(ws, name, remote);
  if (expected && !equal(before, expected))
    throw new Failure("guest output differs from its manifest", 74, {
      expected,
      observed: before,
    });
  if (exists(local)) {
    if (equal({ sha256: digest(local), size: fs.statSync(local).size }, before))
      return { local, remote, resumed: true, ...before };
    throw new Failure("download refuses to overwrite an existing output", 2);
  }
  mkdir(path.dirname(local));
  const tmp = local + ".partial-" + identity();
  _sftp(ws, name, tmp, remote, "download");
  const after = { sha256: digest(tmp), size: fs.statSync(tmp).size };
  if (!equal(before, after) || !equal(before, remote_file(ws, name, remote)))
    throw new Failure(
      "download hash/size mismatch; partial output retained",
      74,
      { expected: before, observed: after },
    );
  fs.renameSync(tmp, local);
  return { local, remote, ...after };
}
export function job_id(v) {
  if (typeof v !== "string" || !/^op-[0-9a-f]{32}$/.test(v))
    throw new Failure("invalid Windows job ID", 2);
  return v;
}
export async function payloads(ws, name) {
  const files = [
      "Control.ps1",
      "Task.ps1",
      "LoadedIdentity.cs",
      "Toolchain.ps1",
      "RegistryProjection.ps1",
    ].map((n) => path.join(env.WB_DEVBOX_PAYLOADS, n)),
    id = hash(files.map(digest).join("")),
    remote = ROOT + "\\control\\" + id,
    [, guest] = connection(ws, name);
  await locked(
    path.join(ws.state, "locks", "windows-control-" + guest.identity + ".lock"),
    () => {
      const names = files.map((p) => literal(path.basename(p))).join(","),
        script =
          "$ErrorActionPreference='Stop'; $root=" +
          literal(remote) +
          "; New-Item -ItemType Directory -Path $root -Force | Out-Null; @{files=@(foreach($name in @(" +
          names +
          ")) {$path=Join-Path $root $name; if(Test-Path -LiteralPath $path -PathType Leaf) {@{name=$name;size=(Get-Item $path).Length;sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLower()}}})} | ConvertTo-Json -Depth 5 -Compress";
      const existing = Object.fromEntries(
        JSON.parse(
          invoke(ws, name, script).stdout.replace(/^\uFEFF/, ""),
        ).files.map((e) => [e.name, e]),
      );
      for (const p of files) {
        const entry = existing[path.basename(p)];
        if (entry) {
          if (entry.sha256 !== digest(p) || entry.size !== fs.statSync(p).size)
            throw new Failure("published Windows control bundle changed", 74, {
              path: path.basename(p),
            });
        } else upload(ws, name, p, remote + "\\" + path.basename(p));
      }
    },
  );
  return remote;
}
export async function submit(
  ws,
  name,
  operationId,
  script,
  purpose,
  arguments_ = [],
  direct = false,
  metadata = {},
  inputs = {},
) {
  if (!PURPOSES.has(purpose))
    throw new Failure("purpose must be build, install, desktop or system", 2);
  job_id(operationId);
  script = fs.realpathSync(script);
  if (!file(script) || path.extname(script).toLowerCase() !== ".ps1")
    throw new Failure("run requires a PowerShell script file", 2);
  const [directory, record] = connection(ws, name),
    local = path.join(directory, "windows-jobs", operationId);
  mkdir(path.dirname(local));
  fs.mkdirSync(local, { mode: 0o700 });
  ws.journal(operationId, {
    kind: "windows-job",
    name,
    state: "preparing",
    operationId,
    purpose,
    localEvidence: local,
    guestIdentity: record.identity,
  });
  const control = await payloads(ws, name),
    remote = ROOT + "\\jobs\\" + operationId;
  invoke(
    ws,
    name,
    "$ErrorActionPreference='Stop'; if(Test-Path -LiteralPath " +
      literal(remote) +
      ") {throw 'Guest job already exists'}; New-Item -ItemType Directory -Path " +
      literal(remote) +
      " | Out-Null",
  );
  const transfers = [upload(ws, name, script, remote + "\\payload.ps1")];
  for (const [filename, p] of Object.entries(inputs)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename))
      throw new Failure("invalid staged input filename", 2);
    transfers.push(upload(ws, name, p, remote + "\\" + filename));
  }
  const request = {
    schemaVersion: 1,
    operationId,
    guestIdentity: record.identity,
    purpose,
    script: remote + "\\payload.ps1",
    scriptSha256: transfers[0].sha256,
    scriptSize: transfers[0].size,
    arguments: arguments_,
    metadata,
    inputs: transfers
      .slice(1)
      .map((f) => ({ path: f.remote, sha256: f.sha256, size: f.size })),
  };
  write_json(path.join(local, "request.json"), request);
  transfers.push(
    upload(
      ws,
      name,
      path.join(local, "request.json"),
      remote + "\\request.json",
    ),
  );
  const receipt = {
    schemaVersion: 1,
    kind: "windows-job",
    state: "staged",
    name,
    operationId,
    guestIdentity: record.identity,
    remote,
    control,
    requestSha256: transfers.at(-1).sha256,
    transfers,
    purpose,
    metadata,
  };
  write_json(path.join(local, "job.json"), receipt);
  ws.journal(operationId, receipt);
  const result = _control(ws, name, receipt, direct ? "direct" : "start");
  write_json(path.join(local, "observation.json"), result);
  ws.journal(operationId, {
    ...receipt,
    state: result.state,
    observation: result,
  });
  return result;
}
export function _control(ws, name, receipt, action, timeout = 120000) {
  const script =
      "& " +
      literal(receipt.control + "\\Control.ps1") +
      " -Action " +
      literal(action) +
      " -JobRoot " +
      literal(receipt.remote) +
      " -RequestSha256 " +
      literal(receipt.requestSha256),
    proc = invoke(ws, name, script, false, timeout);
  let result;
  try {
    result = JSON.parse(proc.stdout.replace(/^\uFEFF/, ""));
  } catch {
    throw new Failure(
      proc.stderr.trim() ||
        proc.stdout.trim() ||
        "guest task returned no receipt",
      proc.returncode || 1,
    );
  }
  if (proc.returncode && !result.exitCode)
    throw new Failure(
      "transport failed after guest observation",
      proc.returncode,
      { observation: result },
    );
  return result;
}
export function job(
  ws,
  name,
  identifier,
  action,
  operationId,
  timeout = 120000,
) {
  job_id(identifier);
  const [directory, record] = connection(ws, name),
    local = path.join(directory, "windows-jobs", identifier),
    receipt = readJSON(path.join(local, "job.json"));
  if (
    receipt.guestIdentity !== record.identity ||
    receipt.operationId !== identifier
  )
    throw new Failure("Windows job belongs to a different guest", 2);
  const result = _control(ws, name, receipt, action, timeout);
  write_json(path.join(local, "observation.json"), result);
  ws.journal(operationId, {
    kind: "windows-job-" + action,
    name,
    jobId: identifier,
    observation: result,
  });
  return result;
}
export async function wait(ws, name, identifier, allowReboot = false) {
  for (;;) {
    const result = job(ws, name, identifier, "status", identifier);
    if (!["running", "queued"].includes(result.state)) {
      if (allowReboot && result.state === "reboot-required") return result;
      if (result.exitCode)
        throw new Failure("Windows task " + result.state, result.exitCode, {
          jobId: identifier,
          observation: result,
        });
      return result;
    }
    await sleep(5000);
  }
}
export async function observe_wait(
  ws,
  name,
  identifier,
  operationId,
  timeout = 45,
) {
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 50)
    throw new Failure("wait timeout must be 0..50 seconds", 2);
  const deadline = Date.now() + timeout * 1000;
  let result;
  do {
    const budget = timeout === 0 ? 5000 : Math.max(100, deadline - Date.now());
    result = job(ws, name, identifier, "status", operationId, budget);
    if (!["queued", "running"].includes(result.state))
      return { ...result, terminal: true, timedOut: false };
    if (Date.now() >= deadline) break;
    await sleep(Math.min(1000, deadline - Date.now()));
  } while (true);
  return {
    ...result,
    terminal: false,
    timedOut: true,
    externalStep:
      "Wait again using this guest name and original task ID; timeout preserves the Windows task.",
  };
}
export function windows_source_files(root) {
  const boundary = resolve(root),
    files = [],
    links = [];
  const visit = (directory, relative, ancestors) => {
    const resolved = resolve(directory);
    if (!within(resolved, boundary) || ancestors.has(resolved))
      throw new Failure(
        "source directory link escapes or cycles within its snapshot",
        2,
      );
    for (const p of list(directory)) {
      const name = relative
        ? relative + "/" + path.basename(p)
        : path.basename(p);
      if (symlink(p)) {
        if (!within(resolve(p), boundary) || !exists(p))
          throw new Failure("source link escapes or is broken", 2, {
            path: name,
          });
        links.push({
          path: name,
          target: fs.readlinkSync(p),
          materialized: dir(p) ? "directory" : "file",
        });
      }
      if (dir(p)) visit(p, name, new Set([...ancestors, resolved]));
      else if (file(p)) files.push([name, p]);
      else throw new Failure("unsupported source file type", 2, { path: name });
    }
  };
  visit(root, "", new Set());
  return [files, links];
}
export function materialize_source(root, destination) {
  const [files, links] = windows_source_files(root),
    names = new Set();
  for (const [relative] of files) {
    const name = windows_relative(relative).toLowerCase();
    if (names.has(name))
      throw new Failure("case-aliased Windows snapshot paths", 2, {
        path: relative,
      });
    names.add(name);
  }
  for (const [relative, source] of files) {
    const output = path.join(destination, relative);
    mkdir(path.dirname(output));
    fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, fs.statSync(source).mode);
  }
  return links;
}
export async function mirror_sources(ws, name, components, mode, operationId) {
  const directory = path.join(ws.state, "windows-sources", operationId);
  mkdir(directory);
  const sources = {},
    files = new Map();
  await ws.repo_locks(components, () => {
    for (const component of components) {
      const original = ws.validate_checkout(component),
        exported = path.join(directory, "sources", component),
        info = builds._export(
          original,
          exported,
          mode,
          ws.repos[component].pin.rev,
          ["dxvk", "vkd3d-proton", "dxil-spirv", "clvk-helios"].includes(
            component,
          )
            ? builds.selected_gitlinks(ws, component)
            : new Set(),
        );
      info.narHash = run([
        env.WB_NIX,
        "hash",
        "path",
        "--sri",
        exported,
      ]).stdout.trim();
      const [exportedFiles, links] = windows_source_files(exported);
      info.windowsLinks = links;
      const relative = windows_relative(ws.repos[component].path);
      sources[component] = {
        relativePath: relative,
        canonicalUrl: ws.repos[component].url,
        ...info,
      };
      for (const [exportedRelative, p] of exportedFiles) {
        const target = windows_relative(relative + "/" + exportedRelative),
          key = target.toLowerCase(),
          f = { path: target, sha256: digest(p), size: fs.statSync(p).size };
        if (files.has(key) && !equal(files.get(key)[0], f))
          throw new Failure(
            "conflicting/case-aliased Windows snapshot paths",
            2,
            { path: target },
          );
        files.set(key, [f, p]);
      }
    }
  });
  const sorted = [...files.values()].sort((a, b) =>
      a[0].path < b[0].path ? -1 : 1,
    ),
    archive = path.join(directory, "sources.zip");
  await create_zip(
    archive,
    sorted.map(([f, p]) => [p, f.path]),
  );
  const remote = ROOT + "\\jobs\\" + operationId,
    spec = {
      schemaVersion: 1,
      operationId,
      mode,
      sources,
      files: sorted.map(([f]) => f),
      archive: remote + "\\sources.zip",
      archiveSha256: digest(archive),
      archiveSize: fs.statSync(archive).size,
    };
  write_json(path.join(directory, "snapshot.json"), spec);
  const result = await submit(
    ws,
    name,
    operationId,
    path.join(env.WB_DEVBOX_PAYLOADS, "Snapshot.ps1"),
    "build",
    [remote + "\\snapshot.json"],
    false,
    { kind: "mirror", sources },
    {
      "snapshot.json": path.join(directory, "snapshot.json"),
      "sources.zip": archive,
    },
  );
  if (result.exitCode)
    throw new Failure("source mirror submission failed", result.exitCode, {
      observation: result,
    });
  await wait(ws, name, operationId);
  return {
    state: "mirrored",
    operationId,
    sourceRoot: "C:\\WinBoatDev\\src\\" + operationId,
    sources,
    snapshotSha256: digest(path.join(directory, "snapshot.json")),
    archiveSha256: spec.archiveSha256,
  };
}
const newest = (paths) =>
  paths.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const childrenFiles = (root, filename) =>
  list(root)
    .map((p) => path.join(p, filename))
    .filter(file);
export async function mirror_build_tools(ws, name, kind = "widl") {
  const operationId = identity(),
    directory = path.join(ws.state, "windows-tools", operationId);
  mkdir(directory);
  const expression = {
      widl: "WB_WINDOWS_TOOLS_EXPRESSION",
      cargo: "WB_WINDOWS_RUST_EXPRESSION",
      utilities: "WB_WINDOWS_UTILITIES_EXPRESSION",
      clvk: "WB_WINDOWS_COMPONENT_EXPRESSION",
      mesa: "WB_WINDOWS_COMPONENT_EXPRESSION",
    }[kind],
    command = [
      env.WB_NIX,
      "build",
      "--json",
      "--out-link",
      path.join(directory, "result"),
      "--file",
      env[expression],
      "--argstr",
      "nixpkgsPath",
      env.WB_NIXPKGS,
    ];
  if (kind === "cargo")
    command.push("--argstr", "sourcePath", ws.validate_checkout("helios"));
  if (["clvk", "mesa"].includes(kind))
    command.push(
      "--argstr",
      "sourcePath",
      ws.validate_checkout(kind === "clvk" ? "clvk-helios" : "mesa-helios"),
    );
  const log = fs.openSync(path.join(directory, "build.log"), "w");
  let proc;
  try {
    proc = run(command, { stderr: log, check: false });
  } finally {
    fs.closeSync(log);
  }
  if (proc.returncode)
    throw new Failure(
      "Windows prerequisite Nix build failed",
      proc.returncode,
      { log: path.join(directory, "build.log") },
    );
  const built = JSON.parse(proc.stdout);
  write_json(path.join(directory, "nix-build.json"), built);
  const output = built[0].outputs.out,
    files = [],
    paths = [],
    seen = new Set();
  for (const p of walk(output).filter(file)) {
    const relative = windows_relative(path.relative(output, p));
    if (seen.has(relative.toLowerCase()))
      throw new Failure("Windows prerequisite has case-aliased files", 74, {
        path: relative,
      });
    seen.add(relative.toLowerCase());
    files.push({
      path: relative,
      sha256: digest(p),
      size: fs.statSync(p).size,
    });
    paths.push([p, relative]);
  }
  const [guestDirectory, guestRecord] = connection(ws, name);
  const makeResult = (id, snapshot) => ({
    operationId: id,
    kind,
    root: "C:\\WinBoatDev\\src\\" + id,
    derivation: built[0].drvPath,
    storePath: output,
    narHash: run([env.WB_NIX, "hash", "path", "--sri", output]).stdout.trim(),
    files,
    snapshotSha256: digest(snapshot),
  });
  for (const previous of newest(
    childrenFiles(path.join(ws.state, "windows-tools"), "nix-build.json"),
  )) {
    const priorDir = path.dirname(previous),
      id = path.basename(priorDir);
    if (priorDir === directory || !equal(readJSON(previous), built)) continue;
    const snapshot = path.join(priorDir, "snapshot.json"),
      originalJob = path.join(guestDirectory, "windows-jobs", id, "job.json");
    if (!exists(snapshot) || !exists(originalJob)) continue;
    const original = readJSON(originalJob);
    if (
      original.guestIdentity !== guestRecord.identity ||
      original.metadata?.toolKind !== kind
    )
      continue;
    const hashes = original.transfers
      .filter((t) => t.remote.endsWith("\\snapshot.json"))
      .map((t) => t.sha256);
    if (
      !equal(hashes, [digest(snapshot)]) ||
      !equal(readJSON(snapshot).files, files)
    )
      continue;
    let observation = job(ws, name, id, "status", operationId);
    if (["queued", "running"].includes(observation.state))
      try {
        observation = await wait(ws, name, id);
      } catch (e) {
        if (!(e instanceof Failure) || !e.details.observation) throw e;
        continue;
      }
    if (observation.state !== "succeeded") continue;
    const reused = { ...makeResult(id, snapshot), reusedVerifiedMirror: true };
    write_json(path.join(directory, "mirror.json"), reused);
    return reused;
  }
  const archive = path.join(directory, "sources.zip");
  await create_zip(archive, paths);
  const remote = ROOT + "\\jobs\\" + operationId,
    spec = {
      schemaVersion: 1,
      operationId,
      mode: "locked-tools",
      sources: {},
      files,
      archive: remote + "\\sources.zip",
      archiveSha256: digest(archive),
      archiveSize: fs.statSync(archive).size,
    };
  write_json(path.join(directory, "snapshot.json"), spec);
  await submit(
    ws,
    name,
    operationId,
    path.join(env.WB_DEVBOX_PAYLOADS, "Snapshot.ps1"),
    "build",
    [remote + "\\snapshot.json"],
    false,
    {
      kind: "build-prerequisites",
      toolKind: kind,
      derivation: built[0].drvPath,
    },
    {
      "snapshot.json": path.join(directory, "snapshot.json"),
      "sources.zip": archive,
    },
  );
  await wait(ws, name, operationId);
  const result = makeResult(operationId, path.join(directory, "snapshot.json"));
  write_json(path.join(directory, "mirror.json"), result);
  return result;
}
export async function validate_dependency_sources(ws, manifest, mode) {
  if (Object.keys(manifest.sources).some((s) => !(s in ws.paths)))
    throw new Failure("dependency names an unknown source repository", 2);
  return ws.repo_locks(Object.keys(manifest.sources), () => {
    for (const [source, snapshot] of Object.entries(manifest.sources)) {
      if (
        git(ws.paths[source], "rev-parse", "HEAD").stdout.trim() !==
        snapshot.revision
      )
        throw new Failure(
          "dependency source revision differs from the selected checkout",
          2,
          { source },
        );
      if (
        mode === "release" &&
        (ws.repos[source].pin.rev !== snapshot.revision ||
          git(
            ws.paths[source],
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ).stdout)
      )
        throw new Failure(
          "release dependency requires a clean checkout at its declared pin",
          2,
          { source },
        );
    }
  });
}
export async function import_artifact(
  ws,
  name,
  manifestPath,
  configuration,
  mode,
) {
  manifestPath = ws.resolve(manifestPath);
  const [, guest] = connection(ws, name);
  return locked(
    path.join(
      ws.state,
      "locks",
      "windows-import-" + guest.identity + "-" + digest(manifestPath) + ".lock",
    ),
    () => _import_artifact(ws, name, manifestPath, configuration, mode),
  );
}
export async function _import_artifact(
  ws,
  name,
  manifestPath,
  configuration,
  mode,
) {
  const verified = builds.verify(manifestPath),
    manifest = readJSON(manifestPath),
    selection = builds.plan(ws, manifest.target, configuration, mode),
    toolchain = manifest.toolchain ?? {};
  if (
    selection.contract.toolchain !== "linux-msvc-cross" ||
    manifest.configuration !== configuration ||
    !toolchain.msvc ||
    toolchain.lockSha256 !== digest(path.join(ws.root, "devenv.lock")) ||
    toolchain.msvc.lockSha256 !==
      digest(path.join(ws.root, "config/provision.lock.json"))
  )
    throw new Failure(
      "cross dependency configuration or locked toolchain differs",
      2,
    );
  if (
    mode === "release" &&
    (manifest.mode !== "release" ||
      Object.values(manifest.sources).some(
        (s) => s.diffSha256 || s.untracked?.length,
      ))
  )
    throw new Failure(
      "release dependency requires a clean pinned cross artifact",
      2,
    );
  await validate_dependency_sources(ws, manifest, mode);
  const images = [];
  for (const image of manifest.images ?? [])
    if (["PE", "COFF archive"].includes(image.format)) {
      if (
        !["x64", "x86"].includes(image.architecture) ||
        !image.staticCrtVerified
      )
        throw new Failure(
          "cross dependency lacks architecture/static CRT proof",
          2,
        );
      images.push({ path: image.path, architecture: image.architecture });
    }
  const declared = new Set(images.map((i) => i.path)),
    binaries = new Set(
      manifest.files
        .filter((f) =>
          [".a", ".lib", ".dll", ".sys", ".exe"].includes(
            path.extname(f.path).toLowerCase(),
          ),
        )
        .map((f) => f.path),
    );
  if (
    !images.length ||
    !equal(declared, binaries) ||
    declared.size !== images.length
  )
    throw new Failure(
      "cross dependency image set differs from its file manifest",
      2,
    );
  const seen = new Set();
  for (const f of manifest.files) {
    const relative = windows_relative(f.path);
    if (
      seen.has(relative.toLowerCase()) ||
      "linkTarget" in f ||
      f.type === "directorySymlink"
    )
      throw new Failure(
        "cross dependency has Windows aliases or linked files",
        2,
      );
    seen.add(relative.toLowerCase());
  }
  const [directory, guest] = connection(ws, name),
    manifestHash = verified.manifestSha256;
  for (const p of newest(
    childrenFiles(path.join(ws.state, "windows-imports"), "import.json"),
  )) {
    const previous = readJSON(p);
    if (
      previous.guestIdentity !== guest.identity ||
      previous.manifestSha256 !== manifestHash
    )
      continue;
    const jp = path.join(
        directory,
        "windows-jobs",
        job_id(previous.operationId),
        "job.json",
      ),
      snapshot = path.join(path.dirname(p), "snapshot.json");
    if (!file(jp) || !file(snapshot)) continue;
    const original = readJSON(jp),
      hashes = original.transfers
        .filter((f) => f.remote.endsWith("\\snapshot.json"))
        .map((f) => f.sha256);
    if (
      original.guestIdentity !== guest.identity ||
      !equal(hashes, [digest(snapshot)]) ||
      original.metadata?.manifestSha256 !== manifestHash
    )
      continue;
    if (
      job(ws, name, previous.operationId, "status", identity()).state ===
      "succeeded"
    )
      return { ...previous, reusedVerifiedMirror: true };
  }
  const operationId = identity(),
    local = path.join(ws.state, "windows-imports", operationId);
  mkdir(local);
  const archive = path.join(local, "artifact.zip");
  await create_zip(
    archive,
    manifest.files.map((f) => [
      path.join(path.dirname(manifestPath), "files", f.path),
      f.path,
    ]),
  );
  if (builds.verify(manifestPath).manifestSha256 !== manifestHash)
    throw new Failure("cross dependency changed during import", 74);
  const remote = ROOT + "\\jobs\\" + operationId,
    spec = {
      schemaVersion: 1,
      operationId,
      destinationKind: "artifact",
      manifestSha256: manifestHash,
      target: manifest.target,
      files: manifest.files,
      images,
      provisionLockSha256: toolchain.msvc.lockSha256,
      archive: remote + "\\artifact.zip",
      archiveSha256: digest(archive),
      archiveSize: fs.statSync(archive).size,
    };
  write_json(path.join(local, "snapshot.json"), spec);
  await submit(
    ws,
    name,
    operationId,
    path.join(env.WB_DEVBOX_PAYLOADS, "Snapshot.ps1"),
    "build",
    [remote + "\\snapshot.json"],
    false,
    {
      kind: "cross-artifact-import",
      manifestSha256: manifestHash,
      target: manifest.target,
      hostDerivation: manifest.outputs[0].drvPath,
    },
    {
      "snapshot.json": path.join(local, "snapshot.json"),
      "artifact.zip": archive,
    },
  );
  await wait(ws, name, operationId);
  const result = {
    operationId,
    guestIdentity: guest.identity,
    guest: name,
    artifactId: manifest.artifactId,
    manifestSha256: manifestHash,
    snapshotSha256: digest(path.join(local, "snapshot.json")),
    root: "C:\\WinBoatDev\\build\\" + operationId + "\\artifact",
    hostOutputs: manifest.outputs,
    toolchain,
    state: "imported",
    installed: false,
    loaded: false,
  };
  write_json(path.join(local, "import.json"), result);
  return result;
}
export async function build(
  ws,
  name,
  target,
  configuration,
  mode,
  operationId,
  dependencyManifests = [],
) {
  const plan = builds.plan(ws, target, configuration, mode),
    recipe = plan.dispatch ?? {};
  if (
    !recipe.commands?.length ||
    ![
      "dxvk-engine-x64",
      "dxvk-engine-x86",
      "vkd3d-engine-x64",
      "vkd3d-engine-x86",
      "helios-guest-x64",
      "helios-guest-x86",
      "mesa-guest-x64",
      "mesa-guest-x86",
      "clvk-helios",
      "helios-development-package",
    ].includes(target)
  )
    throw new Failure(
      "Stage 4 target still needs its complete fixed input/recipe closure",
      3,
      { plan, backend: "devbox" },
    );
  if (!recipe.backendAvailable && mode !== "development")
    throw new Failure(
      "Stage 4 candidate backend requires explicit development mode until native acceptance passes",
      3,
      { target },
    );
  const observed = devbox.guest_status(ws, name, operationId);
  if (observed.phase !== "verified")
    throw new Failure(
      "component build requires a verified guest toolchain",
      3,
      {
        phase: observed.phase,
        guestError: observed.error,
        observation: path.join(
          devbox.load(ws, name)[0],
          "guest-observation.json",
        ),
      },
    );
  if (
    (recipe.outputs ?? []).some((v) => ["shader-libraries", "pdb"].includes(v))
  )
    throw new Failure(
      "component recipe must enumerate every required output before execution",
      3,
      { target },
    );
  let prerequisites = target.startsWith("vkd3d")
    ? [await mirror_build_tools(ws, name)]
    : [];
  const componentDependencies = [],
    selectedDependencies = new Map();
  for (let p of dependencyManifests) {
    p = ws.resolve(p);
    builds.verify(p);
    const manifest = readJSON(p),
      dependencyTarget = manifest.target;
    if (
      selectedDependencies.has(dependencyTarget) ||
      manifest.configuration !== configuration
    )
      throw new Failure(
        "dependency manifest has duplicate target, configuration or guest mismatch",
        2,
      );
    if (!manifest.toolchain?.msvc) {
      if (manifest.provenance.guest !== name)
        throw new Failure("dependency artifact belongs to another guest", 2);
      const [directory, guestRecord] = connection(ws, name),
        original = readJSON(
          path.join(
            directory,
            "windows-jobs",
            job_id(manifest.artifactId),
            "job.json",
          ),
        );
      if (original.guestIdentity !== guestRecord.identity)
        throw new Failure(
          "dependency artifact belongs to another guest identity",
          2,
        );
    }
    if (
      mode === "release" &&
      (manifest.mode !== "release" ||
        Object.values(manifest.sources).some(
          (s) => s.diffSha256 || s.untracked?.length,
        ))
    )
      throw new Failure(
        "release package requires clean pinned dependency builds",
        2,
      );
    selectedDependencies.set(dependencyTarget, [p, manifest]);
  }
  async function componentDependency(componentTarget) {
    let manifestPath, manifest;
    if (selectedDependencies.has(componentTarget)) {
      [manifestPath, manifest] = selectedDependencies.get(componentTarget);
      selectedDependencies.delete(componentTarget);
      const current = builds.plan(ws, componentTarget, configuration, mode);
      await validate_dependency_sources(ws, manifest, mode);
      if (
        !manifest.toolchain?.msvc &&
        !equal(
          current.dispatch.outputs,
          readJSON(
            path.join(
              ws.state,
              "windows-builds",
              manifest.artifactId,
              "build.json",
            ),
          ).outputs,
        )
      )
        throw new Failure(
          "dependency outputs differ from the selected recipe",
          2,
        );
    } else {
      const dependency = await builds.execute(
        ws,
        componentTarget,
        configuration,
        mode,
        identity(),
        name,
      );
      manifestPath = dependency.manifest;
      manifest = readJSON(manifestPath);
    }
    const imported = manifest.toolchain?.msvc
      ? await import_artifact(ws, name, manifestPath, configuration, mode)
      : null;
    componentDependencies.push({
      target: componentTarget,
      artifactId: manifest.artifactId,
      manifestSha256: digest(manifestPath),
      files: manifest.files,
      sources: manifest.sources,
      componentDependencies: manifest.componentDependencies ?? [],
      prerequisites: manifest.prerequisites ?? [],
      import: imported,
      root:
        imported?.root ??
        "C:\\WinBoatDev\\build\\" + manifest.artifactId + "\\artifact",
    });
  }
  if (target.startsWith("mesa-guest"))
    prerequisites = [
      await mirror_build_tools(ws, name, "utilities"),
      await mirror_build_tools(ws, name, "mesa"),
    ];
  if (target === "clvk-helios")
    prerequisites = [
      await mirror_build_tools(ws, name, "utilities"),
      await mirror_build_tools(ws, name, "clvk"),
    ];
  if (target === "helios-development-package")
    for (const t of [
      "helios-guest-x64",
      "mesa-guest-x64",
      "mesa-guest-x86",
      "clvk-helios",
    ])
      await componentDependency(t);
  else if (target.startsWith("helios-guest")) {
    prerequisites = [await mirror_build_tools(ws, name, "cargo")];
    for (const architecture of target.endsWith("x64")
      ? ["x64", "x86"]
      : ["x86"])
      for (const engine of ["dxvk", "vkd3d"])
        await componentDependency(engine + "-engine-" + architecture);
  }
  if (selectedDependencies.size)
    throw new Failure("unused dependency manifests for this build target", 2, {
      targets: [...selectedDependencies.keys()].sort(),
    });
  const mirror = await mirror_sources(
      ws,
      name,
      plan.contract.repositories,
      mode,
      identity(),
    ),
    buildRoot = "C:\\WinBoatDev\\build\\" + operationId,
    component = target.startsWith("helios")
      ? "helios"
      : target.startsWith("clvk")
        ? "clvk-helios"
        : target.startsWith("mesa")
          ? "mesa-helios"
          : target.startsWith("dxvk")
            ? "dxvk"
            : "vkd3d-proton",
    sources = mirror.sources,
    sourceRoot = mirror.sourceRoot;
  const bindings = {
    "@sourceDirectory@":
      sourceRoot + "\\" + sources[component].relativePath.replaceAll("/", "\\"),
    "@buildDirectory@": buildRoot,
    "@specification@": ROOT + "\\jobs\\" + operationId + "\\build.json",
  };
  if (recipe.nativeFile)
    bindings["@nativeFile@"] =
      bindings["@sourceDirectory@"] +
      "\\nix\\" +
      path.basename(recipe.nativeFile);
  if (sources.helios)
    bindings["@heliosSourceDirectory@"] =
      sourceRoot + "\\" + sources.helios.relativePath.replaceAll("/", "\\");
  const commands = recipe.commands.map((command) =>
    command.map((value) => {
      for (const [token, bound] of Object.entries(bindings))
        value = value.replaceAll(token, bound);
      if (/@[A-Za-z]+@/.test(value))
        throw new Failure("unbound Windows recipe token", 2, { token: value });
      return value;
    }),
  );
  const remote = ROOT + "\\jobs\\" + operationId,
    specification = {
      schemaVersion: 1,
      operationId,
      target,
      architecture: recipe.architecture,
      configuration,
      sourceRoot,
      buildRoot,
      sources,
      commands,
      outputs: recipe.outputs,
      outputArchitectures: recipe.outputArchitectures ?? {},
      prerequisites,
      componentDependencies,
      preserveDirectories: recipe.preserveDirectories ?? [],
      symbolStorage: recipe.symbolStorage ?? "artifact",
      provisionLockSha256: observed.lockSha256,
    },
    local = path.join(ws.state, "windows-builds", operationId);
  write_json(path.join(local, "build.json"), specification);
  write_json(path.join(local, "plan.json"), plan);
  const receipt = {
    kind: "windows-build",
    name,
    state: "building",
    target,
    mirror,
    specification: path.join(local, "build.json"),
    windowsJobId: operationId,
  };
  ws.journal(operationId, receipt);
  await submit(
    ws,
    name,
    operationId,
    path.join(env.WB_DEVBOX_PAYLOADS, "GuestBuild.ps1"),
    "build",
    [remote + "\\build.json"],
    false,
    { kind: "build", target },
    { "build.json": path.join(local, "build.json") },
  );
  await wait(ws, name, operationId);
  return collect_build(
    ws,
    name,
    operationId,
    receipt,
    plan,
    local,
    sources,
    configuration,
    mode,
  );
}
export function read_image_inspections(p, target, outputs) {
  if (!exists(p)) return [];
  const text = read(p);
  if (
    !text.trim() &&
    target === "helios-development-package" &&
    !outputs.some((p) =>
      [".a", ".lib", ".dll", ".sys", ".exe"].includes(
        path.extname(p).toLowerCase(),
      ),
    )
  )
    return [];
  let images;
  try {
    images = JSON.parse(text);
  } catch {
    throw new Failure("invalid Windows image inspection receipt", 74, {
      path: p,
    });
  }
  if (!Array.isArray(images))
    throw new Failure("Windows image inspection receipt must be an array", 74, {
      path: p,
    });
  return images;
}
export async function collect_build(
  ws,
  name,
  operationId,
  receipt,
  plan,
  local,
  sources,
  configuration,
  mode,
) {
  const remote = ROOT + "\\jobs\\" + operationId,
    resultPath = path.join(local, "build-result.json");
  download(ws, name, remote + "\\build-result.json", resultPath);
  const result = readJSON(resultPath);
  if (
    result.schemaVersion !== 1 ||
    result.state !== "built" ||
    result.operationId !== operationId
  )
    throw new Failure("unexpected guest build result", 74);
  if (result.output !== "C:\\WinBoatDev\\build\\" + operationId + "\\artifact")
    throw new Failure("guest build output escaped its operation directory", 74);
  const exported = path.join(ws.out, "guest", operationId),
    manifestPath = path.join(exported, "manifest.json");
  if (exists(manifestPath)) {
    const verified = builds.verify(manifestPath),
      existing = readJSON(manifestPath);
    if (
      existing.artifactId !== operationId ||
      existing.target !== plan.target ||
      !equal(existing.sources, sources)
    )
      throw new Failure(
        "existing artifact belongs to another build identity",
        74,
      );
    Object.assign(receipt, {
      state: "succeeded",
      exitCode: 0,
      manifest: manifestPath,
      manifestSha256: verified.manifestSha256,
      collected: true,
    });
    ws.journal(operationId, receipt);
    return receipt;
  }
  const seen = new Set();
  for (const f of result.files) {
    const relative = windows_relative(f.path);
    if (seen.has(relative.toLowerCase()))
      throw new Failure("duplicate guest output path", 74);
    seen.add(relative.toLowerCase());
  }
  if (result.archive) {
    const archive = result.archive;
    if (
      archive.path !==
      "C:\\WinBoatDev\\build\\" + operationId + "\\artifact.zip"
    )
      throw new Failure("guest archive escaped its operation directory", 74);
    const p = path.join(local, "artifact.zip");
    download(ws, name, archive.path, p, {
      sha256: archive.sha256,
      size: archive.size,
    });
    await extract_artifact(p, path.join(exported, "files"), result.files);
  } else {
    const exportRequest = path.join(local, "export-operation.json");
    let exportId;
    if (exists(exportRequest))
      exportId = job_id(readJSON(exportRequest).operationId);
    else {
      exportId = identity();
      await submit(
        ws,
        name,
        exportId,
        path.join(env.WB_DEVBOX_PAYLOADS, "ExportArtifact.ps1"),
        "build",
        [ROOT + "\\jobs\\" + exportId + "\\original-build-result.json"],
        false,
        { kind: "artifact-export", originalOperationId: operationId },
        { "original-build-result.json": resultPath },
      );
      write_json(exportRequest, { operationId: exportId });
    }
    await wait(ws, name, exportId);
    const archiveReceipt = path.join(local, "artifact-export.json");
    download(
      ws,
      name,
      ROOT + "\\jobs\\" + exportId + "\\artifact-export.json",
      archiveReceipt,
    );
    const archive = readJSON(archiveReceipt);
    if (
      archive.originalOperationId !== operationId ||
      archive.path !== "C:\\WinBoatDev\\build\\" + exportId + "\\artifact.zip"
    )
      throw new Failure(
        "supplemental export differs from its original artifact identity",
        74,
      );
    const p = path.join(local, "artifact.zip");
    download(ws, name, archive.path, p, {
      sha256: archive.sha256,
      size: archive.size,
    });
    for (const partial of walk(path.join(exported, "files")).filter((p) =>
      /\.partial-op-/.test(p),
    )) {
      const destination = path.join(
        exported,
        "partials",
        path.relative(path.join(exported, "files"), partial),
      );
      mkdir(path.dirname(destination));
      fs.renameSync(partial, destination);
    }
    await extract_artifact(p, path.join(exported, "files"), result.files);
  }
  const files = builds._files(path.join(exported, "files")),
    required = new Set(
      plan.dispatch.outputs.map((p) => windows_relative(p).toLowerCase()),
    ),
    missing = [...required].filter((p) => !seen.has(p));
  if (missing.length)
    throw new Failure("guest result omitted a required component output", 74, {
      missing: missing.sort(),
    });
  const buildSpec = readJSON(path.join(local, "build.json")),
    images = read_image_inspections(
      path.join(exported, "files/images.json"),
      plan.target,
      plan.dispatch.outputs,
    );
  const manifest = {
    schemaVersion: 1,
    artifactId: operationId,
    target: plan.target,
    abi: plan.contract.abi,
    configuration,
    mode,
    sources,
    dependencies: Object.fromEntries(
      Object.entries(sources).map(([k, v]) => [k, v.revision]),
    ),
    toolchain: {
      lockSha256: plan.lockSha256,
      provisionLockSha256: devbox.load(ws, name)[1].provisioning.lockSha256,
      observed: result.toolchain,
    },
    files,
    licenses: files
      .filter((f) => f.path.startsWith("licenses/"))
      .map((f) => f.path),
    symbols: files.filter((f) => f.path.endsWith(".pdb")).map((f) => f.path),
    provenance: { operationId, guest: name, job: remote },
    prerequisites: buildSpec.prerequisites ?? [],
    componentDependencies: buildSpec.componentDependencies ?? [],
    state: "built",
    installed: false,
    loaded: false,
    images,
    imageVerification: images.length
      ? "architecture-and-crt-inspected"
      : "unavailable-in-earlier-operation",
    embeddedSymbols: images
      .filter((i) => i.embeddedCodeView)
      .map((i) => i.path),
    recipe: {
      rootRevision: git(ws.root, "rev-parse", "HEAD").stdout.trim(),
      rootDiffSha256: hash(git(ws.root, "diff", "--binary", "HEAD").stdout),
      controlPlaneStorePath: env.WB_OPERATION_SOURCES,
      sharedOperationsNarHash: run([
        env.WB_NIX,
        "hash",
        "path",
        "--sri",
        path.dirname(env.WB_DEVBOX_PAYLOADS),
      ]).stdout.trim(),
    },
  };
  if (!manifest.licenses.length)
    throw new Failure("Windows artifact lacks retained license notices", 74);
  write_json(manifestPath, manifest);
  for (const p of walk(exported))
    if (file(p)) fs.chmodSync(p, fs.statSync(p).mode & ~0o222);
  Object.assign(receipt, {
    state: "succeeded",
    exitCode: 0,
    manifest: manifestPath,
    manifestSha256: digest(manifestPath),
  });
  ws.journal(operationId, receipt);
  return receipt;
}
export async function mapped_kernel_identity(image, base, readMapped) {
  if (image.length < 64 || image.subarray(0, 2).toString() !== "MZ")
    throw new Failure("invalid kernel PE image", 76);
  const number = (type, offset) => {
    try {
      return type === "H"
        ? image.readUInt16LE(offset)
        : type === "I"
          ? image.readUInt32LE(offset)
          : image.readBigUInt64LE(offset);
    } catch {
      throw new Failure("truncated kernel PE image", 76);
    }
  };
  const pe = number("I", 60);
  if (
    !image.subarray(pe, pe + 4).equals(Buffer.from("PE\0\0")) ||
    number("H", pe + 4) !== 0x8664 ||
    number("H", pe + 24) !== 0x20b
  )
    throw new Failure("native x64 kernel PE required", 76);
  const optional = pe + 24,
    table = optional + number("H", pe + 20),
    count = number("H", pe + 6);
  if (count > 96 || table + count * 40 > image.length)
    throw new Failure("invalid kernel PE section table", 76);
  const headerSize = table + count * 40,
    header = await readMapped(0, headerSize, "header");
  if (header.length !== headerSize)
    throw new Failure("incomplete mapped kernel header", 76);
  if (
    !header.subarray(pe, pe + 24).equals(image.subarray(pe, pe + 24)) ||
    !header
      .subarray(optional + 56, optional + 60)
      .equals(image.subarray(optional + 56, optional + 60))
  )
    return { state: "stale-mapped-image", sections: [] };
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = table + 40 * i,
      row = {
        name: image
          .subarray(at, at + 8)
          .toString("ascii")
          .replace(/\0+$/, ""),
        rva: number("I", at + 12),
        size: number("I", at + 16),
        raw: number("I", at + 20),
        flags: number("I", at + 36),
      };
    if (row.raw + row.size > image.length || row.size > 32 * 1024 * 1024)
      throw new Failure("invalid kernel PE section extent", 76);
    sections.push(row);
  }
  const delta = BigInt(base) - number("Q", optional + 24),
    relocRva = number("I", optional + 152),
    relocSize = number("I", optional + 156),
    relocations = [];
  if (delta && relocSize) {
    const candidates = sections.filter(
      (s) => s.rva <= relocRva && relocRva + relocSize <= s.rva + s.size,
    );
    if (candidates.length !== 1)
      throw new Failure("kernel relocations escaped a raw section", 76);
    let start = candidates[0].raw + relocRva - candidates[0].rva;
    const end = start + relocSize;
    while (start < end) {
      if (start + 8 > end)
        throw new Failure("truncated kernel relocation block", 76);
      const page = number("I", start),
        size = number("I", start + 4);
      if (size < 8 || size % 2 || start + size > end)
        throw new Failure("invalid kernel relocation block", 76);
      for (let at = start + 8; at < start + size; at += 2) {
        const entry = number("H", at);
        if (entry >>> 12)
          relocations.push([page + (entry & 4095), entry >>> 12]);
      }
      start += size;
    }
  }
  const result = [];
  for (const [i, section] of sections.entries()) {
    if (
      !(section.flags & 0x20000000) ||
      section.flags & 0x02000000 ||
      !section.size
    )
      continue;
    const mapped = Buffer.from(
      await readMapped(section.rva, section.size, String(i)),
    );
    if (mapped.length !== section.size)
      throw new Failure("incomplete mapped kernel section", 76);
    for (const [address, kind] of relocations) {
      const at = address - section.rva;
      if (at < 0 || at >= mapped.length) continue;
      if (kind !== 10 || at + 8 > mapped.length)
        throw new Failure("unsupported resident kernel relocation", 76);
      mapped.writeBigUInt64LE(
        BigInt.asUintN(64, mapped.readBigUInt64LE(at) - delta),
        at,
      );
    }
    const expected = image.subarray(section.raw, section.raw + section.size);
    result.push({
      name: section.name,
      rva: section.rva,
      size: section.size,
      normalizedSha256: hash(mapped),
      expectedSha256: hash(expected),
      matches: mapped.equals(expected),
    });
  }
  return {
    state:
      result.length && result.every((s) => s.matches)
        ? "mapped-code-matches"
        : result.length
          ? "stale-mapped-image"
          : "unknown-no-resident-executable-section",
    sections: result,
    discardableSectionsExcluded: true,
  };
}
export function kernel_base(value) {
  // LoadedIdentity.cs serializes native pointers as exact hexadecimal strings.
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]{1,16}$/i.test(value))
    throw new Failure("invalid loaded kernel base address", 76);
  return BigInt("0x" + value.replace(/^0x/i, ""));
}
export async function observe_kernel(ws, name, result, operationId) {
  const [directory] = connection(ws, name),
    observations = [];
  for (const [i, module] of (result.kernelModules ?? []).entries()) {
    const observed = { ...module, state: "unknown" };
    observations.push(observed);
    try {
      const base = kernel_base(module.BaseAddress);
      if (
        !base ||
        !Number.isInteger(module.ImageSize) ||
        module.ImageSize <= 0 ||
        module.ImageSize >= 32 * 1024 * 1024
      )
        throw new Failure("invalid loaded kernel module extent", 76);
      let p = module.Path;
      if (p.toLowerCase().startsWith("\\systemroot\\"))
        p = "C:\\Windows\\" + p.slice("\\SystemRoot\\".length);
      if (p.startsWith("\\??\\")) p = p.slice(4);
      const normalized = path.win32.normalize(p).toLowerCase();
      if (
        (path.win32.dirname(normalized) !== "c:\\windows\\system32\\drivers" &&
          normalized !==
            "c:\\programdata\\winboatdev\\fixture\\wbdev-test.sys" &&
          !(
            normalized.startsWith(
              "c:\\windows\\system32\\driverstore\\filerepository\\",
            ) && path.win32.basename(normalized) === "helios_kmd_render.sys"
          )) ||
        path.win32.extname(normalized) !== ".sys"
      )
        throw new Failure(
          "loaded kernel module disk path outside the driver directory",
          76,
        );
      const local = path.join(
        directory,
        "kernel-observations",
        operationId,
        String(i),
      );
      mkdir(local);
      const imagePath = path.join(local, "selected.sys");
      observed.disk = download(ws, name, p, imagePath);
      observed.qmp = await devbox.qmp_observe(directory, "query-cpus-fast");
      const cpus = observed.qmp.response.map((c) => c["cpu-index"]),
        reads = [];
      const readMapped = async (rva, size, section) => {
        if (rva + size > module.ImageSize)
          throw new Failure("kernel read outside loaded module extent", 76);
        for (const cpu of cpus) {
          const destination = path.join(
              local,
              section + "-cpu-" + cpu + ".bin",
            ),
            remote = "/state/" + path.relative(directory, destination),
            address = base + BigInt(rva);
          // QMP needs an exact uint64 JSON number; JavaScript Number loses kernel
          // addresses. JSON.rawJSON is supplied by the pinned Node 24 runtime.
          const args = {
            val: JSON.rawJSON(address.toString()),
            size,
            filename: remote,
            "cpu-index": cpu,
          };
          try {
            const response = await devbox.qmp_observe(
              directory,
              "memsave",
              args,
            );
            if (fs.statSync(destination).size !== size)
              throw new Failure("QMP kernel read incomplete", 76);
            reads.push({
              rva,
              size,
              cpu,
              sha256: digest(destination),
              path: destination,
              qmp: response,
            });
            return fs.readFileSync(destination);
          } catch (e) {
            reads.push({ rva, size, cpu, error: e.message, path: destination });
          }
        }
        throw new Failure(
          "resident kernel memory unavailable on every vCPU",
          76,
        );
      };
      Object.assign(
        observed,
        await mapped_kernel_identity(
          fs.readFileSync(imagePath),
          base,
          readMapped,
        ),
      );
      observed.reads = reads;
      const currentBoot = invoke(
        ws,
        name,
        "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
      ).stdout.trim();
      if (currentBoot !== result.bootTime)
        throw new Failure("guest rebooted during kernel observation", 76);
      observed.bootTime = currentBoot;
      observed.expectedArtifact = null;
    } catch (e) {
      observed.error = e.message;
    }
  }
  return observations;
}
function inventory_record(result, location) {
  if (
    ![1, 2].includes(result.schemaVersion) ||
    (result.schemaVersion === 2 &&
      result.transactionsView !== "summary-with-retained-receipts")
  )
    throw new Failure("unsupported Windows inventory schema/view", 76, {
      path: location,
    });
  return result;
}
export async function registry(ws, name, mode, operationId) {
  name = devbox.name_check(name);
  const retained = path.join(devbox.location(ws, name), "stack-registry.json");
  if (mode === "show" && file(retained))
    return {
      ...inventory_record(readJSON(retained), retained),
      observationKind: "retained",
      exitCode: 0,
    };
  await submit(
    ws,
    name,
    operationId,
    path.join(env.WB_DEVBOX_PAYLOADS, "Registry.ps1"),
    "system",
    [mode],
  );
  let observation;
  try {
    observation = await wait(ws, name, operationId);
  } catch (e) {
    if (!(e instanceof Failure) || e.code !== 76 || !e.details.observation)
      throw e;
    observation = e.details.observation;
  }
  const local = path.join(
    ws.state,
    "devboxes",
    name,
    "windows-jobs",
    operationId,
    "registry-result.json",
  );
  download(
    ws,
    name,
    ROOT + "\\jobs\\" + operationId + "\\registry-result.json",
    local,
  );
  const result = inventory_record(readJSON(local), local),
    host = devbox.status(ws, name),
    [directory, record] = devbox.load(ws, name);
  result.host = {
    runtimeState: host.state,
    loaded: host.loaded ?? false,
    hostArtifact: record.hostArtifact,
  };
  if (host.loaded && exists(path.join(directory, "host-observation.json")))
    result.host.observation = readJSON(
      path.join(directory, "host-observation.json"),
    );
  if (mode !== "show" && host.loaded)
    result.kernelImages = await observe_kernel(ws, name, result, operationId);
  const pkg = result.requestedPackage;
  if (pkg) {
    const requiredSys = pkg.files.filter(
        (f) => f.path.toLowerCase() === "payload/driver/helios_kmd_render.sys",
      ),
      kernels = (result.kernelImages ?? []).filter(
        (k) =>
          path.win32.basename(k.Path).toLowerCase() === "helios_kmd_render.sys",
      );
    if (requiredSys.length === 1 && kernels.length === 1) {
      kernels[0].expectedArtifact = {
        sha256: requiredSys[0].sha256.toLowerCase(),
        sources: pkg.source,
        manifestSha256: result.packageProvenance.manifestSha256,
      };
      result.loadedKernelIdentity = !kernels[0].disk?.sha256
        ? "unknown"
        : kernels[0].disk.sha256 === requiredSys[0].sha256.toLowerCase()
          ? kernels[0].state
          : "drift-selected-sys";
    }
    const graphics = result.graphics ?? {},
      images = graphics.mappedImages ?? [],
      workloads = graphics.workloads ?? [];
    const graphicsVerified =
      graphics.state === "passed" &&
      graphics.sessionId > 0 &&
      graphics.manifestSha256 === result.packageProvenance.manifestSha256 &&
      graphics.bootTime === result.bootTime &&
      images.length === 12 &&
      workloads.length === 13 &&
      images.every((i) => i.mappedCode === "mapped-code-matches") &&
      workloads.every((w) => w.exitCode === 0);
    const hostManifest = readJSON(ws.resolve(record.hostArtifact.manifest)),
      mesaArtifacts = (pkg.artifacts ?? []).filter((a) =>
        a.target.startsWith("mesa-guest-"),
      ),
      keys = ["revision", "snapshotSha256", "narHash", "diffSha256"],
      protocolHost = Object.fromEntries(
        keys.map((k) => [k, hostManifest.sources["venus-protocol"][k] ?? null]),
      ),
      protocolGuests = mesaArtifacts.map((a) =>
        Object.fromEntries(
          keys.map((k) => [k, a.sources["venus-protocol"][k] ?? null]),
        ),
      );
    result.protocolPairing = {
      host: hostManifest.sources["venus-protocol"].revision,
      guest: mesaArtifacts.map((a) => a.sources["venus-protocol"].revision),
      hostIdentity: protocolHost,
      guestIdentities: protocolGuests,
    };
    const paired =
      mesaArtifacts.length === 2 &&
      protocolHost.diffSha256 === null &&
      !!protocolHost.snapshotSha256 &&
      !!protocolHost.narHash &&
      protocolGuests.every((i) => equal(i, protocolHost));
    result.loadedVerified = !!(
      result.installedVerified &&
      result.state !== "drift" &&
      host.loaded &&
      result.loadedKernelIdentity === "mapped-code-matches" &&
      graphicsVerified &&
      paired
    );
    result.loadedEvidenceKind = result.loadedVerified
      ? "resident-kernel-and-recorded-desktop-mappings"
      : "incomplete";
  }
  result.operationId = operationId;
  result.task = Object.fromEntries(
    Object.entries(observation).filter(([k]) => k !== "logs"),
  );
  result.exitCode = observation.exitCode ?? 0;
  if (mode === "verify") {
    result.exitCode = result.loadedVerified ? 0 : 76;
    result.state = result.loadedVerified
      ? "verified"
      : result.state === "drift"
        ? "drift"
        : "incomplete";
  }
  if (result.exitCode)
    result.verificationError =
      "Full selected stack and kernel loaded-image evidence are still required";
  write_json(local, result);
  write_json(retained, result);
  return result;
}
export async function install(
  ws,
  name,
  manifestPath,
  operationId,
  fixture = false,
  failureAfterCopy = false,
  resume = null,
) {
  if (resume) {
    const [directory] = connection(ws, name),
      prior = readJSON(
        path.join(directory, "windows-jobs", job_id(resume), "job.json"),
      );
    if (prior.metadata?.kind !== "install")
      throw new Failure("resume requires an installation transaction ID", 2);
    job(ws, name, resume, "resume", operationId);
    return wait(ws, name, resume, true);
  }
  if (!manifestPath)
    throw new Failure(
      "install requires an exact package --manifest or --resume transaction",
      2,
    );
  manifestPath = ws.resolve(manifestPath);
  const manifest = readJSON(manifestPath);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files))
    throw new Failure("unsupported install package schema", 2);
  if (fixture) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(manifest.fixtureId ?? ""))
      throw new Failure("fixture requires a bounded fixtureId", 2);
  } else if (
    manifest.architecture !== "x64" ||
    !equal(
      new Set(manifest.applicationArchitectures ?? []),
      new Set(["x64", "x86"]),
    ) ||
    manifest.signing?.mode !== "test" ||
    !manifest.source ||
    !Object.keys(manifest.source).length ||
    Object.values(manifest.source).some((v) => !/^[0-9a-f]{40}$/.test(v))
  )
    throw new Failure(
      "complete x64/WoW64 package, signing identity and immutable source commits are required",
      2,
    );
  const local = path.join(ws.state, "windows-installs", operationId);
  mkdir(local);
  const archive = path.join(local, "bundle.zip"),
    seen = new Set(),
    files = [];
  for (const f of manifest.files) {
    const relative = windows_relative(f.path);
    if (
      seen.has(relative.toLowerCase()) ||
      relative.toLowerCase() === "manifest.json"
    )
      throw new Failure("duplicate/reserved install package path", 2);
    seen.add(relative.toLowerCase());
    const p = path.join(path.dirname(manifestPath), relative);
    if (!within(resolve(p), resolve(path.dirname(manifestPath))) || !file(p))
      throw new Failure("package file escaped its root or is missing", 2);
    if (digest(p) !== f.sha256.toLowerCase() || fs.statSync(p).size !== f.size)
      throw new Failure(
        "install package hash/size mismatch; guest state was not changed",
        74,
        { path: relative },
      );
    files.push([p, relative]);
  }
  const requiredScripts = [
    "install-helios.ps1",
    "uninstall-helios.ps1",
    "verify-helios.ps1",
    "helios-packagecommon.ps1",
  ];
  if (!fixture && requiredScripts.some((p) => !seen.has(p)))
    throw new Failure(
      "package must manifest the original installer scripts beside manifest.json",
      2,
      { missing: requiredScripts.filter((p) => !seen.has(p)).sort() },
    );
  if (!fixture) {
    const required = [
      "helios_kmd_render.sys",
      "helios_kmd_render.inf",
      "helios_kmd_render.cat",
      "helios_umd.dll",
      "helios_umd12.dll",
      "helios_umd32.dll",
      "helios_umd12_32.dll",
    ].map((n) => "payload/driver/" + n);
    for (const architecture of ["", "x86/"])
      for (const image of ["vulkan_virtio.dll", "libgallium_wgl.dll"])
        required.push("payload/mesa/" + architecture + image);
    required.push(
      "payload/opencl/clvk.dll",
      "payload/loaders/vulkan-1.dll",
      "payload/loaders/x86/vulkan-1.dll",
      "payload/loaders/opencl.dll",
      windows_relative(manifest.signing.certificate ?? "").toLowerCase(),
    );
    const missing = required.filter((p) => !seen.has(p));
    if (missing.length)
      throw new Failure(
        "complete native/WoW64 stack and signing certificate are required before installation",
        2,
        { missing: missing.sort() },
      );
  }
  files.push([manifestPath, "manifest.json"]);
  await create_zip(archive, files);
  const remote = ROOT + "\\jobs\\" + operationId,
    spec = {
      schemaVersion: 1,
      kind: fixture ? "fixture" : "helios",
      operationId,
      archive: remote + "\\bundle.zip",
      archiveSha256: digest(archive),
      archiveSize: fs.statSync(archive).size,
      manifestSha256: digest(manifestPath),
      requestedManifest: manifest,
      failureAfterCopy,
    };
  write_json(path.join(local, "install.json"), spec);
  await submit(
    ws,
    name,
    operationId,
    path.join(env.WB_DEVBOX_PAYLOADS, "Install.ps1"),
    "install",
    [remote + "\\install.json"],
    false,
    {
      kind: "install",
      manifestSha256: spec.manifestSha256,
      requested: manifest,
      built: { files: manifest.files },
    },
    { "install.json": path.join(local, "install.json"), "bundle.zip": archive },
  );
  const result = await wait(ws, name, operationId, true);
  return {
    ...result,
    transactionId: operationId,
    installedVerified: false,
    loadedVerified: false,
  };
}
export async function dispatch(ws, args, operationId) {
  switch (args.action) {
    case "run":
      return submit(
        ws,
        args.name,
        operationId,
        args.script,
        args.purpose,
        args.argument,
        args.direct,
      );
    case "job":
      return args.job_action === "wait"
        ? observe_wait(ws, args.name, args.id, operationId, args.timeout)
        : job(ws, args.name, args.id, args.job_action, operationId);
    case "mirror": {
      if (!args.repo.length)
        throw new Failure("mirror requires explicit --repo selections", 2);
      const components = [...new Set(args.repo)];
      if (components.some((n) => !Object.hasOwn(ws.repos, n)))
        throw new Failure("unknown source repository", 2);
      return mirror_sources(ws, args.name, components, args.mode, operationId);
    }
    case "registry":
      return registry(ws, args.name, args.registry_action, operationId);
    case "smoke": {
      const [directory, record] = connection(ws, args.name),
        original = readJSON(
          path.join(
            directory,
            "windows-jobs",
            job_id(args.transaction),
            "job.json",
          ),
        );
      if (
        original.guestIdentity !== record.identity ||
        original.metadata?.kind !== "install" ||
        original.metadata.requested?.fixtureId
      )
        throw new Failure(
          "graphics smoke requires this guest's complete package installation transaction",
          2,
        );
      const local = path.join(ws.state, "windows-graphics", operationId),
        specification = {
          schemaVersion: 1,
          transactionId: args.transaction,
          manifestSha256: original.metadata.manifestSha256,
          manifest: original.metadata.requested,
        };
      write_json(path.join(local, "graphics.json"), specification);
      await submit(
        ws,
        args.name,
        operationId,
        path.join(env.WB_DEVBOX_PAYLOADS, "Graphics.ps1"),
        "desktop",
        [ROOT + "\\jobs\\" + operationId + "\\graphics.json"],
        false,
        {
          kind: "graphics",
          transactionId: args.transaction,
          manifestSha256: specification.manifestSha256,
        },
        { "graphics.json": path.join(local, "graphics.json") },
      );
      let observation, failure;
      try {
        observation = await wait(ws, args.name, operationId);
      } catch (e) {
        if (!(e instanceof Failure) || !e.details.observation) throw e;
        failure = e;
        observation = e.details.observation;
      }
      const p = path.join(local, "graphics-result.json");
      try {
        download(
          ws,
          args.name,
          ROOT + "\\jobs\\" + operationId + "\\graphics-result.json",
          p,
        );
      } catch (e) {
        throw failure || e;
      }
      const result = readJSON(p);
      result.task = Object.fromEntries(
        Object.entries(observation).filter(([k]) => k !== "logs"),
      );
      result.exitCode = observation.exitCode ?? 0;
      write_json(p, result);
      return result;
    }
    case "install": {
      if (args.rollback) {
        if (args.manifest || args.resume)
          throw new Failure("rollback cannot also specify manifest/resume", 2);
        const [directory] = connection(ws, args.name),
          prior = readJSON(
            path.join(
              directory,
              "windows-jobs",
              job_id(args.rollback),
              "job.json",
            ),
          );
        if (prior.metadata?.kind !== "install")
          throw new Failure("rollback requires an install transaction ID", 2);
        await submit(
          ws,
          args.name,
          operationId,
          path.join(env.WB_DEVBOX_PAYLOADS, "Rollback.ps1"),
          "install",
          [args.rollback],
        );
        return wait(ws, args.name, operationId);
      }
      return install(
        ws,
        args.name,
        args.manifest,
        operationId,
        args.fixture,
        args.failure_after_copy,
        args.resume,
      );
    }
    case "build": {
      if (args.collect) {
        const identifier = job_id(args.collect),
          [directory, record] = connection(ws, args.name),
          receipt = readJSON(
            path.join(directory, "windows-jobs", identifier, "job.json"),
          );
        if (
          receipt.metadata?.kind !== "build" ||
          receipt.guestIdentity !== record.identity
        )
          throw new Failure(
            "collection requires this guest's component build job",
            2,
          );
        const observation = job(
          ws,
          args.name,
          identifier,
          "status",
          operationId,
        );
        if (observation.state !== "succeeded")
          throw new Failure(
            "guest build is not complete",
            observation.exitCode || 75,
            { observation },
          );
        const local = path.join(ws.state, "windows-builds", identifier),
          plan = readJSON(path.join(local, "plan.json")),
          spec = readJSON(path.join(local, "build.json"));
        return collect_build(
          ws,
          args.name,
          identifier,
          receipt,
          plan,
          local,
          spec.sources,
          plan.configuration,
          plan.mode,
        );
      }
      if (!args.target)
        throw new Failure("devbox build requires --target or --collect", 2);
      if (builds.target(args.target).backend === "nix") {
        if (args.dependency_manifest.length)
          throw new Failure(
            "host component builds select dependencies through their Nix closure",
            2,
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
      return build(
        ws,
        args.name,
        args.target,
        args.configuration,
        args.mode,
        operationId,
        args.dependency_manifest,
      );
    }
    default:
      throw new Failure("unknown Windows control operation", 2);
  }
}
