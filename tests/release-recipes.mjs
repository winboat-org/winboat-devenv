// Opt-in local recipe proof. This is not a hosted workflow or installer run.
import {
  fs,
  path,
  env,
  run,
  write_json,
  digest,
  identity,
  file,
  walk,
  mkdir,
} from "../tools/wb/common.mjs";
import { Workspace, discover } from "../tools/wb/workspace.mjs";
import { msvc_inputs } from "../tools/wb/builds.mjs";
import { pe_architecture } from "../tools/wb/bundles.mjs";
const ws = new Workspace(discover()),
  directory = path.join(ws.state, "stage06", "recipes", identity()),
  source = path.join(directory, "source");
mkdir(source);
for (const name of [
  "metadata",
  "packaging/windows/compat",
  "packaging/windows/verify-catalog.c",
  "kmd_render/driver-version.env",
]) {
  const dest = path.join(source, name);
  mkdir(path.dirname(dest));
  fs.cpSync(path.join(ws.root, name), dest, { recursive: true });
}
const spec = {
    configuration: "release",
    sourcePath: source,
    narHash: run([env.WB_NIX, "hash", "path", "--sri", source]).stdout.trim(),
    msvc: msvc_inputs(ws),
  },
  specPath = path.join(directory, "specification.json");
write_json(specPath, spec);
function build(expression, args, logName) {
  const log = fs.openSync(path.join(directory, logName), "wx");
  try {
    const result = run(
      [
        env.WB_NIX,
        "build",
        "--no-link",
        "--json",
        "--file",
        expression,
        "--argstr",
        "nixpkgsPath",
        env.WB_NIXPKGS,
        ...args,
      ],
      { stderr: log },
    );
    return JSON.parse(result.stdout)[0];
  } finally {
    fs.closeSync(log);
  }
}
const compatibility = build(
  env.WB_RELEASE_COMPATIBILITY_EXPRESSION,
  ["--argstr", "specification", specPath],
  "compatibility.log",
);
if (
  pe_architecture(path.join(compatibility.outputs.out, "atiadlxx.dll")) !==
  "x64"
)
  throw Error("Compatibility PE architecture differs");
const installerDependencies = build(
  env.WB_INSTALLER_DEPS_EXPRESSION,
  ["--argstr", "lockFile", path.join(ws.root, "installer/Cargo.lock")],
  "installer-dependencies.log",
);
const result = {
  schemaVersion: 1,
  state: "passed-local-recipes",
  compatibility: {
    derivation: compatibility.drvPath,
    architecture: "x64",
    backend: "linux-msvc-cross",
    files: walk(compatibility.outputs.out)
      .filter(file)
      .map((p) => ({
        path: path.relative(compatibility.outputs.out, p),
        size: fs.statSync(p).size,
        sha256: digest(p),
      })),
  },
  installerDependencies: {
    derivation: installerDependencies.drvPath,
    lockSha256: digest(path.join(ws.root, "installer/Cargo.lock")),
    files: walk(installerDependencies.outputs.out).filter(file).length,
  },
  rootSource: "uncommitted local snapshot; not a hosted release artifact",
  directory,
};
write_json(path.join(directory, "result.json"), result);
console.log(JSON.stringify(result));
