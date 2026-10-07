import {
  fs,
  path,
  env,
  git,
  run,
  hash,
  digest,
  identity,
  mkdir,
  readJSON,
  write_json,
  file,
  walk,
  Failure,
} from "./common.mjs";
import * as builds from "./builds.mjs";
import { create_zip, extract_artifact } from "./archives.mjs";
import { table, safe_file } from "./bundles.mjs";
import { materialize_source } from "./windows.mjs";

function require_(value, message) {
  if (!value) throw new Failure(message, 74);
}
function realize(expression, args) {
  return JSON.parse(
    run(
      [
        env.WB_NIX,
        "build",
        "--impure",
        "--no-link",
        "--json",
        "--print-build-logs",
        "--file",
        expression,
        "--argstr",
        "nixpkgsPath",
        env.WB_NIXPKGS,
        ...args,
      ],
      { stderr: "inherit" },
    ).stdout,
  )[0];
}
export async function prepare(ws, args, operationId, engines) {
  const directory = path.join(ws.root, "out/ci-driver-inputs");
  require_(!fs.existsSync(directory), "driver preparation already exists");
  mkdir(directory);
  const stage = path.join(directory, "stage");
  mkdir(stage);
  const toolkit = realize(env.WB_HOSTED_WINDOWS_TOOLS_EXPRESSION, [
    "--argstr",
    "lockFile",
    path.join(ws.root, "config/provision.lock.json"),
  ]);
  fs.cpSync(toolkit.outputs.out, path.join(stage, "toolchain"), {
    recursive: true,
    dereference: true,
  });
  const sources = {};
  for (const component of ["helios", "dxvk", "vkd3d-proton", "dxil-spirv"]) {
    const repo = ws.repos[component],
      selected =
        component === "helios"
          ? new Set()
          : builds.selected_gitlinks(ws, component),
      exported = path.join(directory, "sources", component),
      destination = path.join(stage, "source", component);
    sources[component] = {
      ...builds._export(
        ws.validate_checkout(component),
        exported,
        "release",
        repo.pin.rev,
        selected,
      ),
      canonicalUrl: repo.url,
      declaredPin: repo.pin.rev,
      relativePath: component,
      narHash: run([
        env.WB_NIX,
        "hash",
        "path",
        "--sri",
        exported,
      ]).stdout.trim(),
      windowsLinks: materialize_source(exported, destination),
    };
  }
  const vendor = realize(env.WB_WINDOWS_RUST_EXPRESSION, [
    "--argstr",
    "sourcePath",
    path.join(stage, "source/helios"),
  ]);
  fs.cpSync(vendor.outputs.out, path.join(stage, "cargo"), {
    recursive: true,
    dereference: true,
  });
  const dependencies = [];
  for (const manifestPath of engines) {
    const manifest = readJSON(manifestPath);
    builds.verify(manifestPath);
    fs.cpSync(
      path.join(path.dirname(manifestPath), "files"),
      path.join(stage, "engines", manifest.target),
      { recursive: true, dereference: true },
    );
    dependencies.push({
      target: manifest.target,
      files: manifest.files,
      manifest,
    });
  }
  const sourceFiles = table(path.join(stage, "source"));
  write_json(path.join(stage, "source/.winboat-snapshot.json"), {
    schemaVersion: 1,
    sources,
    files: sourceFiles,
  });
  const branding = Object.fromEntries(
    ["metadata/helios.env", "kmd_render/driver-version.env"].flatMap((p) =>
      fs
        .readFileSync(path.join(stage, "source/helios", p), "utf8")
        .split(/\r?\n/)
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => l.split("=")),
    ),
  );
  const inputFiles = table(stage),
    archive = path.join(directory, "driver-inputs.zip");
  await create_zip(
    archive,
    inputFiles.map((f) => [path.join(stage, f.path), f.path]),
  );
  write_json(path.join(directory, "driver-request.json"), {
    schemaVersion: 1,
    kind: "winboat-hosted-driver-request",
    operationId,
    rootRevision: args.root_revision,
    configuration: args.configuration,
    provisionLockSha256: digest(
      path.join(ws.root, "config/provision.lock.json"),
    ),
    lockSha256: digest(path.join(ws.root, "devenv.lock")),
    sources,
    branding,
    dependencies,
    recipe: builds.plan(ws, "helios-guest-x64", args.configuration, "release")
      .dispatch,
    toolkitDerivation: toolkit.drvPath,
    vendorDerivation: vendor.drvPath,
    files: inputFiles,
    archive: { sha256: digest(archive), size: fs.statSync(archive).size },
  });
  console.log(JSON.stringify({ state: "prepared", directory, operationId }));
}
export async function collect(ws, args) {
  const prepared = path.resolve(args.prepared_dir),
    compiled = path.resolve(args.compiled_dir),
    spec = readJSON(path.join(prepared, "driver-request.json")),
    result = readJSON(path.join(compiled, "build-result.json"));
  require_(
    spec.kind === "winboat-hosted-driver-request" &&
      spec.rootRevision === args.root_revision &&
      result.operationId === spec.operationId &&
      result.state === "built",
    "hosted driver identity differs",
  );
  for (const [name, source] of Object.entries(spec.sources))
    require_(
      source.revision === ws.repos[name].pin.rev &&
        !source.diffSha256 &&
        !source.untracked.length,
      "hosted driver source differs",
    );
  const archive = path.join(compiled, "artifact.zip");
  require_(
    digest(archive) === result.archive.sha256 &&
      fs.statSync(archive).size === result.archive.size,
    "hosted driver archive differs",
  );
  const output = path.join(ws.out, "release-components", identity());
  mkdir(output);
  await extract_artifact(archive, path.join(output, "files"), result.files);
  const files = builds._files(path.join(output, "files")),
    manifest = {
      schemaVersion: 1,
      target: "helios-guest-x64",
      state: "built",
      mode: "release",
      configuration: spec.configuration,
      sources: spec.sources,
      dependencies: Object.fromEntries(
        Object.entries(spec.sources).map(([n, s]) => [n, s.revision]),
      ),
      files,
      licenses: files
        .filter((f) => f.path.startsWith("licenses/"))
        .map((f) => f.path),
      symbols: files.filter((f) => f.path.endsWith(".pdb")).map((f) => f.path),
      images: readJSON(path.join(output, "files/images.json")),
      toolchain: {
        lockSha256: spec.lockSha256,
        provisionLockSha256: spec.provisionLockSha256,
        observed: result.toolchain,
        toolkitDerivation: spec.toolkitDerivation,
        vendorDerivation: spec.vendorDerivation,
      },
      branding: spec.branding,
      recipe: { rootRevision: spec.rootRevision, rootDiffSha256: hash("") },
      provenance: {
        operationId: spec.operationId,
        execution: "github-hosted-windows",
      },
      installed: false,
      loaded: false,
    };
  const p = path.join(output, "manifest.json");
  write_json(p, manifest);
  builds.verify(p);
  return p;
}
