// Executed exclusively by repository-owned component jobs, never root release CI.
import crypto from "node:crypto";
import {
  fs,
  path,
  env,
  Failure,
  git,
  digest,
  hash,
  readJSON,
  write_json,
  mkdir,
  run,
  spawn,
  identity,
  valid_sha,
  file,
  walk,
  equal,
} from "./common.mjs";
import { Workspace, discover } from "./workspace.mjs";
import * as builds from "./builds.mjs";
import * as windows from "./windows.mjs";
import * as devbox from "./devbox.mjs";
import { create_zip, extract_artifact } from "./archives.mjs";
import {
  ROOT_REPOSITORY,
  OWNERS,
  table,
  pe_architecture,
  relative,
  safe_file,
} from "./bundles.mjs";

function require_(condition, message) {
  if (!condition) throw new Failure(message, 74);
}
function clean_root(ws, revision) {
  require_(
    valid_sha(revision) &&
      git(ws.root, "rev-parse", "HEAD").stdout.trim() === revision,
    "component job requires the exact selected root commit",
  );
  require_(
    !git(
      ws.root,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ).stdout.trim(),
    "component root source must be committed and clean",
  );
}
function file_record(p, relativePath) {
  return { path: relativePath, sha256: digest(p), size: fs.statSync(p).size };
}
function source_dependencies(ws, target, manifest) {
  const dependencies = Object.fromEntries(
    Object.entries(manifest?.sources ?? {}).map(([name, s]) => [
      name,
      s.revision,
    ]),
  );
  dependencies[OWNERS[target]] = ws.repos[OWNERS[target]].pin.rev;
  if (target.startsWith("helios-") || target === "clvk-helios")
    for (const name of [
      "helios",
      "dxvk",
      "vkd3d-proton",
      "dxil-spirv",
      "venus-protocol",
      "mesa-helios",
    ])
      dependencies[name] = ws.repos[name].pin.rev;
  return dependencies;
}
function destination(target, p) {
  if (p.startsWith("licenses/") || p.startsWith("share/licenses/"))
    return "licenses/" + target + "/" + p;
  if (/\.pdb$/i.test(p)) return null;
  if (target === "helios-guest-x64") {
    if (
      /^package\/helios_(kmd_render\.(sys|inf|cat)|umd(12|32|12_32)?\.dll)$/.test(
        p,
      )
    )
      return "payload/driver/" + path.basename(p);
    if (p === "package/helios-dev-test.cer")
      return "certificate/helios-dev-test.cer";
    if (p === "toolchain.json") return "payload/driver/toolchain.json";
  }
  if (target.startsWith("mesa-guest-")) {
    const names = ["vulkan_virtio.dll", "libgallium_wgl.dll", "opengl32.dll"];
    if (names.includes(path.basename(p)))
      return (
        "payload/mesa/" +
        (target.endsWith("x86") ? "x86/" : "") +
        path.basename(p)
      );
  }
  if (target === "clvk-helios") {
    if (p === "package/clvk.dll") return "payload/opencl/clvk.dll";
    if (
      [
        "package/vulkan-1.dll",
        "package/OpenCL.dll",
        "package/x86/vulkan-1.dll",
      ].includes(p)
    )
      return "payload/loaders/" + p.slice(8);
    if (p.startsWith("package/smoke/") && p.endsWith(".exe"))
      return "payload/smoke/" + p.slice(14);
  }
  if (
    target === "helios-compatibility" &&
    [
      "atiadlxx.dll",
      "README.md",
      "Resolve-CompatibilityCommon.ps1",
      "Install-Resolve-Compatibility.ps1",
      "Uninstall-Resolve-Compatibility.ps1",
    ].includes(p)
  )
    return "compatibility/DaVinci Resolve/" + p;
  return null;
}
async function export_closure(manifest, destination) {
  const closure = manifest.closure ?? {};
  const paths = Array.isArray(closure)
    ? closure.map((p) => (typeof p === "string" ? p : p.path))
    : Object.keys(closure);
  if (!paths.length) return null;
  require_(
    paths.every((p) => typeof p === "string" && p.startsWith("/nix/store/")),
    "invalid component store closure",
  );
  const p = path.join(destination, "closure.nar"),
    fd = fs.openSync(p, "wx");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(env.WB_NIX_STORE, ["--export", ...paths], {
        stdio: ["ignore", fd, "inherit"],
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code
          ? reject(new Failure("component closure export failed", code))
          : resolve(),
      );
    });
  } finally {
    fs.closeSync(fd);
  }
  return file_record(p, "closure.nar");
}
export async function seal(
  ws,
  target,
  configuration,
  rootRevision,
  manifestPath,
  output,
  workflow,
) {
  clean_root(ws, rootRevision);
  builds.verify(manifestPath);
  const built = readJSON(manifestPath),
    owner = OWNERS[target],
    filesRoot = path.join(path.dirname(manifestPath), "files");
  require_(
    built.target === (target === "qemu-helios" ? "host-stack" : target) &&
      built.mode === "release" &&
      built.configuration === configuration,
    "component build identity differs",
  );
  for (const [name, s] of Object.entries(built.sources))
    require_(
      s.revision === ws.repos[name].pin.rev &&
        !s.diffSha256 &&
        !s.untracked?.length,
      "dirty or mismatched component build source",
    );
  if (built.recipe)
    require_(
      built.recipe.rootRevision === rootRevision &&
        built.recipe.rootDiffSha256 === hash(""),
      "dirty/mismatched root recipe provenance",
    );
  require_(
    built.toolchain.lockSha256 === digest(path.join(ws.root, "devenv.lock")),
    "component toolchain lock differs",
  );
  mkdir(output);
  mkdir(path.join(output, "files"));
  const copied = new Set();
  const copy = (p, relativePath) => {
    relative(relativePath);
    if (copied.has(relativePath.toLowerCase()))
      throw new Failure("duplicate portable component output", 74);
    copied.add(relativePath.toLowerCase());
    const dest = path.join(output, relativePath);
    mkdir(path.dirname(dest));
    fs.copyFileSync(p, dest, fs.constants.COPYFILE_EXCL);
  };
  for (const p of walk(filesRoot).filter(file))
    copy(p, "files/" + path.relative(filesRoot, p).replaceAll(path.sep, "/"));
  copy(manifestPath, "build-manifest.json");
  if (target === "qemu-helios" || target === "virglrenderer")
    require_(
      await export_closure(built, output),
      "host component requires its complete Nix closure",
    );
  const files = table(output).map((f) => {
    const original = f.path.startsWith("files/") ? f.path.slice(6) : f.path;
    const payloadPath = destination(target, original);
    return {
      ...f,
      ...(payloadPath ? { payloadPath } : {}),
      ...(/\.(dll|exe|sys)$/i.test(f.path)
        ? { architecture: pe_architecture(path.join(output, f.path)) }
        : {}),
    };
  });
  const m = {
    schemaVersion: 1,
    kind: "winboat-component-artifact",
    state: "built",
    mode: "release",
    repository: workflow.repository,
    sourceRepository: "winboat-org/" + owner,
    revision: ws.repos[owner].pin.rev,
    rootRevision,
    target,
    buildTarget: built.target,
    configuration,
    architecture: target.endsWith("x86")
      ? "x86"
      : ["clvk-helios", "helios-guest-x64"].includes(target)
        ? "x64+x86"
        : "x64",
    abi: ["qemu-helios", "virglrenderer"].includes(target)
      ? "linux"
      : "msvc-mt",
    dependencies: source_dependencies(ws, target, built),
    toolchain: {
      lockSha256: built.toolchain.lockSha256,
      identity: hash(JSON.stringify(built.toolchain)),
      observed: built.toolchain,
    },
    workflow,
    files,
    licenses: files
      .filter((f) => /(^|\/)licenses\//.test(f.path))
      .map((f) => f.path),
    symbols: files
      .filter((f) => /\.pdb$|\/debug\//i.test(f.path))
      .map((f) => f.path),
    embeddedSymbols: built.embeddedSymbols ?? false,
    sourceProvenance: built.sources,
    originalManifestSha256: digest(manifestPath),
  };
  require_(
    m.licenses.length > 0,
    "component artifact requires license attribution",
  );
  if (target === "helios-guest-x64") {
    const cert = files.find(
        (f) => f.payloadPath === "certificate/helios-dev-test.cer",
      ),
      cat = files.find(
        (f) => f.payloadPath === "payload/driver/helios_kmd_render.cat",
      );
    require_(cert && cat, "driver requires already signed catalog/certificate");
    const certificate = new crypto.X509Certificate(
      fs.readFileSync(path.join(output, cert.path)),
    );
    m.signing = {
      mode: "test",
      subject: certificate.subject.replaceAll("\n", ", "),
      thumbprint: certificate.fingerprint.replaceAll(":", ""),
      certificate: cert.payloadPath,
      certificateSha256: cert.sha256,
      catalogSha256: cat.sha256,
    };
    const branding = Object.fromEntries(
      ["metadata/helios.env", "kmd_render/driver-version.env"].flatMap((p) =>
        fs
          .readFileSync(path.join(ws.paths.helios, p), "utf8")
          .split(/\r?\n/)
          .filter((l) => /^[A-Z0-9_]+=/.test(l))
          .map((l) => l.split("=")),
      ),
    );
    m.version = branding.HELIOS_KMD_VERSION;
    m.productName = branding.HELIOS_PRODUCT;
    m.publisher = branding.HELIOS_PUBLISHER;
  }
  if (target === "clvk-helios")
    m.upstream = readJSON(
      path.join(output, "files/package/source-revisions.json"),
    );
  if (target === "helios-catalog-verifier")
    m.verifier = {
      interfaceVersion: 1,
      path: "files/VerifyCatalog.exe",
      sourceRevision: rootRevision,
      sourceRepository: ROOT_REPOSITORY,
    };
  write_json(path.join(output, "component.json"), m);
  return m;
}
async function installer_build(ws, args, operationId) {
  require_(
    args.name &&
      devbox.guest_status(ws, args.name, operationId).phase === "verified",
    "installer build requires a verified Windows toolchain",
  );
  const directory = path.join(ws.state, "release-components", operationId),
    stage = path.join(directory, "stage");
  mkdir(stage);
  const p = run([
    env.WB_NIX,
    "build",
    "--no-link",
    "--json",
    "--file",
    env.WB_INSTALLER_DEPS_EXPRESSION,
    "--argstr",
    "nixpkgsPath",
    env.WB_NIXPKGS,
    "--argstr",
    "lockFile",
    path.join(ws.root, "installer/Cargo.lock"),
  ]);
  const vendor = JSON.parse(p.stdout)[0];
  write_json(path.join(directory, "vendor-build.json"), vendor);
  const rootPaths = git(
    ws.root,
    "ls-files",
    "--",
    "installer",
    "ci/windows/Build-Installer.ps1",
    "ci/windows/Initialize-HeliosBuild.ps1",
  )
    .stdout.trim()
    .split("\n");
  for (const p of rootPaths) {
    const dest = path.join(stage, "source", p);
    mkdir(path.dirname(dest));
    fs.copyFileSync(safe_file(ws.root, p), dest);
  }
  for (const p of walk(vendor.outputs.out).filter(file)) {
    const dest = path.join(
      stage,
      "dependencies",
      path.relative(vendor.outputs.out, p),
    );
    mkdir(path.dirname(dest));
    fs.copyFileSync(p, dest);
  }
  const archive = path.join(directory, "component-inputs.zip"),
    files = table(stage);
  await create_zip(
    archive,
    files.map((f) => [path.join(stage, f.path), f.path]),
  );
  const guestId = identity(),
    remote = windows.ROOT + "\\jobs\\" + guestId,
    spec = {
      schemaVersion: 1,
      operationId: guestId,
      target: "helios-installer",
      rootRevision: args.root_revision,
      configuration: args.configuration,
      files,
      archiveSha256: digest(archive),
      archiveSize: fs.statSync(archive).size,
    };
  write_json(path.join(directory, "request.json"), spec);
  await windows.submit(
    ws,
    args.name,
    guestId,
    path.join(env.WB_DEVBOX_PAYLOADS, "ReleaseComponent.ps1"),
    "build",
    ["-Specification", remote + "\\request.json"],
    false,
    { kind: "installer-component", rootRevision: args.root_revision },
    {
      "request.json": path.join(directory, "request.json"),
      "component-inputs.zip": archive,
    },
  );
  await windows.wait(ws, args.name, guestId);
  const resultPath = path.join(directory, "result.json");
  windows.download(
    ws,
    args.name,
    remote + "\\component-result.json",
    resultPath,
  );
  const result = readJSON(resultPath);
  require_(
    result.operationId === guestId &&
      result.rootRevision === args.root_revision &&
      result.state === "built" &&
      result.archive.path ===
        "C:\\WinBoatDev\\build\\" + guestId + "\\artifact.zip",
    "installer component receipt differs",
  );
  const output = path.join(ws.out, "release-components", operationId);
  mkdir(output);
  const returned = path.join(directory, "artifact.zip");
  windows.download(
    ws,
    args.name,
    result.archive.path,
    returned,
    result.archive,
  );
  await extract_artifact(returned, path.join(output, "files"), result.files);
  const manifest = {
    schemaVersion: 1,
    state: "built",
    artifactId: operationId,
    target: "helios-installer",
    configuration: args.configuration,
    mode: "release",
    sources: {
      helios: {
        revision: ws.repos.helios.pin.rev,
        diffSha256: null,
        untracked: [],
      },
    },
    files: builds._files(path.join(output, "files")),
    toolchain: {
      lockSha256: digest(path.join(ws.root, "devenv.lock")),
      vendorDerivation: vendor.drvPath,
      observed: result.toolchain,
    },
    licenses: builds
      ._files(path.join(output, "files"))
      .filter((f) => f.path.includes("licenses/"))
      .map((f) => f.path),
    symbols: builds
      ._files(path.join(output, "files"))
      .filter((f) => f.path.endsWith(".pdb"))
      .map((f) => f.path),
    images: readJSON(path.join(output, "files/images.json")),
    recipe: { rootRevision: args.root_revision, rootDiffSha256: hash("") },
    installed: false,
    loaded: false,
  };
  const manifestPath = path.join(output, "manifest.json");
  write_json(manifestPath, manifest);
  return manifestPath;
}
async function windows_release_tool_build(ws, args, operationId) {
  const directory = path.join(ws.state, "release-components", operationId);
  mkdir(directory);
  const source = path.join(directory, "source");
  mkdir(source);
  for (const p of git(
    ws.root,
    "ls-files",
    "--",
    "packaging/windows/compat",
    "packaging/windows/verify-catalog.c",
    "metadata",
    "kmd_render/driver-version.env",
  )
    .stdout.trim()
    .split("\n")) {
    const dest = path.join(source, p);
    mkdir(path.dirname(dest));
    fs.copyFileSync(safe_file(ws.root, p), dest);
  }
  const specification = {
    target: args.target,
    configuration: args.configuration,
    sourcePath: source,
    narHash: run([env.WB_NIX, "hash", "path", "--sri", source]).stdout.trim(),
    msvc: builds.msvc_inputs(ws),
  };
  const specPath = path.join(directory, "specification.json");
  write_json(specPath, specification);
  const result = JSON.parse(
    run([
      env.WB_NIX,
      "build",
      "--no-link",
      "--json",
      "--file",
      args.target === "helios-compatibility"
        ? env.WB_ADL_COMPATIBILITY_EXPRESSION
        : env.WB_CATALOG_VERIFIER_EXPRESSION,
      "--argstr",
      "nixpkgsPath",
      env.WB_NIXPKGS,
      "--argstr",
      "specification",
      specPath,
    ]).stdout,
  )[0];
  write_json(path.join(directory, "nix-build.json"), result);
  const output = path.join(ws.out, "release-components", operationId);
  mkdir(path.join(output, "files"));
  for (const p of walk(result.outputs.out).filter(file)) {
    const dest = path.join(
      output,
      "files",
      path.relative(result.outputs.out, p),
    );
    mkdir(path.dirname(dest));
    fs.copyFileSync(p, dest);
  }
  const manifest = {
    schemaVersion: 1,
    state: "built",
    artifactId: operationId,
    target: args.target,
    configuration: args.configuration,
    mode: "release",
    sources: {
      helios: {
        revision: ws.repos.helios.pin.rev,
        diffSha256: null,
        untracked: [],
      },
    },
    files: builds._files(path.join(output, "files")),
    toolchain: {
      lockSha256: digest(path.join(ws.root, "devenv.lock")),
      derivation: result.drvPath,
      msvc: specification.msvc,
    },
    licenses: builds
      ._files(path.join(output, "files"))
      .filter((f) => f.path.includes("licenses/"))
      .map((f) => f.path),
    symbols: builds
      ._files(path.join(output, "files"))
      .filter((f) => f.path.endsWith(".pdb"))
      .map((f) => f.path),
    images: readJSON(path.join(output, "files/images.json")),
    recipe: { rootRevision: args.root_revision, rootDiffSha256: hash("") },
    installed: false,
    loaded: false,
  };
  const manifestPath = path.join(output, "manifest.json");
  write_json(manifestPath, manifest);
  return manifestPath;
}
async function exact_engines(
  ws,
  selectionJSON,
  rootRevision,
  configuration,
  directory,
) {
  const selection = JSON.parse(selectionJSON);
  require_(
    Array.isArray(selection) && selection.length === 4,
    "Helios production requires four exact engine artifacts",
  );
  mkdir(directory);
  const manifests = [],
    targets = [];
  for (const s of selection) {
    require_(
      typeof s.repository === "string" &&
        /^winboat-org\/(dxvk|vkd3d-proton)$/.test(s.repository) &&
        Number.isSafeInteger(s.artifactId) &&
        s.artifactId > 0 &&
        Number.isSafeInteger(s.runId) &&
        Number.isSafeInteger(s.runAttempt),
      "invalid exact engine artifact selector",
    );
    const meta = JSON.parse(
        run([
          env.WB_GH,
          "api",
          "repos/" + s.repository + "/actions/artifacts/" + s.artifactId,
        ]).stdout,
      ),
      workflow = JSON.parse(
        run([
          env.WB_GH,
          "api",
          "repos/" + s.repository + "/actions/runs/" + s.runId,
        ]).stdout,
      );
    require_(
      !meta.expired &&
        /^sha256:[0-9a-f]{64}$/.test(meta.digest ?? "") &&
        meta.workflow_run.id === s.runId &&
        workflow.run_attempt === s.runAttempt &&
        workflow.conclusion === "success" &&
        workflow.event === "workflow_dispatch" &&
        workflow.head_repository.full_name === s.repository,
      "engine artifact expired/failed/forked/mismatched",
    );
    const archive = path.join(directory, s.artifactId + ".zip"),
      fd = fs.openSync(archive, "wx");
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          env.WB_GH,
          [
            "api",
            "repos/" +
              s.repository +
              "/actions/artifacts/" +
              s.artifactId +
              "/zip",
          ],
          { stdio: ["ignore", fd, "inherit"] },
        );
        child.once("error", reject);
        child.once("close", (code) =>
          code
            ? reject(new Failure("engine download failed", code))
            : resolve(),
        );
      });
    } finally {
      fs.closeSync(fd);
    }
    require_(
      digest(archive) === meta.digest.slice(7),
      "engine archive digest differs",
    );
    // Obtain only the two bounded JSON metadata members before validating the
    // complete ZIP against the normalized file table.
    const { read_metadata } = await import("./release-zip-metadata.mjs");
    const m = await read_metadata(archive, "component.json"),
      original = await read_metadata(archive, "build-manifest.json");
    require_(
      m.value.rootRevision === rootRevision &&
        m.value.configuration === configuration &&
        m.value.workflow.runId === s.runId &&
        m.value.workflow.runAttempt === s.runAttempt &&
        m.value.workflow.headSha === meta.workflow_run.head_sha &&
        m.value.workflow.path === workflow.path &&
        m.value.repository === s.repository,
      "engine provenance differs",
    );
    const target = m.value.target;
    require_(
      [
        "dxvk-engine-x64",
        "dxvk-engine-x86",
        "vkd3d-engine-x64",
        "vkd3d-engine-x86",
      ].includes(target),
      "wrong engine target",
    );
    targets.push(target);
    const owner = OWNERS[target];
    require_(
      m.value.revision === ws.repos[owner].pin.rev &&
        m.value.workflow.headSha === ws.repos[owner].pin.rev &&
        m.value.toolchain.lockSha256 ===
          digest(path.join(ws.root, "devenv.lock")),
      "engine source/toolchain pin differs",
    );
    require_(
      original.value.target === target &&
        original.value.configuration === configuration &&
        original.value.mode === "release" &&
        m.value.originalManifestSha256 === original.record.sha256,
      "original engine manifest differs",
    );
    const dest = path.join(directory, String(s.artifactId));
    await extract_artifact(archive, dest, [m.record, ...m.value.files]);
    const originalPath = path.join(dest, "build-manifest.json");
    builds.verify(originalPath);
    manifests.push(originalPath);
  }
  require_(
    equal(
      targets.sort(),
      [
        "dxvk-engine-x64",
        "dxvk-engine-x86",
        "vkd3d-engine-x64",
        "vkd3d-engine-x86",
      ].sort(),
    ),
    "duplicate or missing engine variant",
  );
  return manifests;
}
export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    require_(
      argv[i].startsWith("--") && argv[i + 1] !== undefined,
      "component argument requires value",
    );
    args[argv[i].slice(2).replaceAll("-", "_")] = argv[i + 1];
  }
  const ws = new Workspace(
      discover(),
      env.WB_CI_STATE_ROOT ? { stateRoot: env.WB_CI_STATE_ROOT } : {},
    ),
    owner = OWNERS[args.target],
    productionOwner = args.target === "clvk-helios" ? "helios" : owner;
  require_(
    owner &&
      ["release", "debug"].includes(args.configuration) &&
      args.owner === productionOwner,
    "invalid repository-owned component target",
  );
  clean_root(ws, args.root_revision);
  require_(
    valid_sha(args.source_revision) &&
      ws.repos[productionOwner].pin.rev === args.source_revision &&
      env.GITHUB_REPOSITORY === "winboat-org/" + productionOwner &&
      env.GITHUB_SHA === args.source_revision &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "workflow must execute the exact selected component pin",
  );
  const [selected] = ws.select({ repo: ["helios", "clvk-helios"] });
  for (const name of ws.order(selected, true)) {
    const state = ws.status([name])[0];
    require_(
      state.head === ws.repos[name].pin.rev && !state.changes.length,
      "managed component sources must be clean and pinned",
    );
  }
  const operationId = identity(),
    workflow = {
      repository: env.GITHUB_REPOSITORY,
      path: (env.GITHUB_WORKFLOW_REF ?? "")
        .slice((env.GITHUB_REPOSITORY + "/").length)
        .split("@")[0],
      runId: Number(env.GITHUB_RUN_ID),
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      headSha: env.GITHUB_SHA,
      event: env.GITHUB_EVENT_NAME,
    };
  require_(
    (env.GITHUB_WORKFLOW_REF ?? "").startsWith(
      env.GITHUB_REPOSITORY + "/.github/workflows/",
    ) &&
      Number.isSafeInteger(workflow.runId) &&
      workflow.runId > 0 &&
      Number.isSafeInteger(workflow.runAttempt) &&
      workflow.runAttempt > 0,
    "missing hosted workflow identity",
  );
  let manifestPath;
  if (args.target === "helios-installer")
    manifestPath = await installer_build(ws, args, operationId);
  else if (
    ["helios-compatibility", "helios-catalog-verifier"].includes(args.target)
  )
    manifestPath = await windows_release_tool_build(ws, args, operationId);
  else if (args.target === "helios-guest-x64") {
    const dependencies = await exact_engines(
      ws,
      args.engine_selection ?? "[]",
      args.root_revision,
      args.configuration,
      path.join(ws.state, "release-components", operationId, "engines"),
    );
    manifestPath = (
      await windows.build(
        ws,
        args.name,
        args.target,
        args.configuration,
        "release",
        operationId,
        dependencies,
      )
    ).manifest;
  } else
    manifestPath = (
      await builds.execute(
        ws,
        args.target === "qemu-helios" ? "host-stack" : args.target,
        args.configuration,
        "release",
        operationId,
        args.name,
      )
    ).manifest;
  const output = path.join(
    ws.out,
    "ci-components",
    args.target + "-" + args.configuration,
  );
  require_(
    !file(path.join(output, "component.json")),
    "component output already exists",
  );
  const m = await seal(
    ws,
    args.target,
    args.configuration,
    args.root_revision,
    manifestPath,
    output,
    workflow,
  );
  if (args.target === "helios-installer") {
    m.installer = {
      interfaceVersion: 1,
      format: "HLIOSET2",
      sourceRevision: args.root_revision,
      sourceRepository: ROOT_REPOSITORY,
      sourcePaths: [
        "installer",
        "packaging/windows",
        "ci/windows/Build-Installer.ps1",
      ],
    };
    write_json(path.join(output, "component.json"), m);
  }
  console.log(
    JSON.stringify({
      state: "built",
      target: args.target,
      manifest: path.join(output, "component.json"),
      directory: output,
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code ?? 1;
  }
