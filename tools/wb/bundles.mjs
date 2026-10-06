import { read_metadata } from "./release-zip-metadata.mjs";
import crypto from "node:crypto";
import {
  fs,
  path,
  env,
  Failure,
  digest,
  hash,
  readJSON,
  write_json,
  mkdir,
  file,
  exists,
  git,
  valid_sha,
  equal,
  identity,
  spawn,
  run,
} from "./common.mjs";
import { windows_relative, extract_artifact, create_zip } from "./archives.mjs";
import * as windows from "./windows.mjs";

export const ROOT_REPOSITORY = "winboat-org/winboat-devenv";
export const INSTALL_SCRIPTS = [
  "Install-Helios.ps1",
  "Uninstall-Helios.ps1",
  "Verify-Helios.ps1",
  "Helios-PackageCommon.ps1",
];
export const REQUIRED = [
  "helios-guest-x64",
  "mesa-guest-x64",
  "mesa-guest-x86",
  "clvk-helios",
  "helios-installer",
  "helios-compatibility",
  "helios-catalog-verifier",
  "qemu-helios",
  "virglrenderer",
  "dxvk-engine-x64",
  "dxvk-engine-x86",
  "vkd3d-engine-x64",
  "vkd3d-engine-x86",
];
export const OWNERS = {
  "helios-guest-x64": "helios",
  "helios-installer": "helios",
  "helios-compatibility": "helios",
  "helios-catalog-verifier": "helios",
  "clvk-helios": "clvk-helios",
  "qemu-helios": "qemu-helios",
  virglrenderer: "virglrenderer",
  "mesa-guest-x64": "mesa-helios",
  "mesa-guest-x86": "mesa-helios",
  "dxvk-engine-x64": "dxvk",
  "dxvk-engine-x86": "dxvk",
  "vkd3d-engine-x64": "vkd3d-proton",
  "vkd3d-engine-x86": "vkd3d-proton",
};
const fail = (message) => {
  throw new Failure(message, 74);
};
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const repo = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const integer = (v) => Number.isSafeInteger(v) && v > 0;
export function relative(value) {
  if (windows_relative(value) !== value) fail("noncanonical release path");
  return value;
}
export function safe_file(root, value) {
  const parts = relative(value).split("/");
  let p = path.resolve(root);
  if (fs.realpathSync(p) !== p) fail("release directory traverses a symlink");
  for (const part of parts) {
    p = path.join(p, part);
    if (fs.lstatSync(p).isSymbolicLink())
      fail("release input traverses a symlink");
  }
  if (!file(p)) fail("missing release file: " + value);
  return p;
}
export function verify_file(root, f) {
  if (!sha(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0)
    fail("invalid release hash/size");
  const p = safe_file(root, f.path);
  if (fs.statSync(p).size !== f.size || digest(p) !== f.sha256)
    fail("release hash/size mismatch: " + f.path);
  return p;
}
export function table(root) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail("release tree contains a symlink");
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile())
        rows.push({
          path: relative(path.relative(root, p).replaceAll(path.sep, "/")),
          size: fs.statSync(p).size,
          sha256: digest(p),
        });
      else fail("release tree contains a special file");
    }
  };
  visit(root);
  return rows;
}
export function pe_architecture(p) {
  const fd = fs.openSync(p, "r");
  try {
    const head = Buffer.alloc(64);
    if (
      fs.readSync(fd, head, 0, 64, 0) !== 64 ||
      head.toString("ascii", 0, 2) !== "MZ"
    )
      fail("invalid PE image");
    const at = head.readUInt32LE(60),
      pe = Buffer.alloc(6);
    if (
      at > fs.statSync(p).size - 6 ||
      fs.readSync(fd, pe, 0, 6, at) !== 6 ||
      pe.readUInt32LE(0) !== 0x4550
    )
      fail("invalid PE header");
    const arch = { 0x8664: "x64", 0x14c: "x86" }[pe.readUInt16LE(4)];
    if (!arch) fail("unsupported PE architecture");
    return arch;
  } finally {
    fs.closeSync(fd);
  }
}
function root_source(ws, root) {
  if (
    !root ||
    root.repository !== ROOT_REPOSITORY ||
    !valid_sha(root.revision) ||
    !sha(root.lockSha256)
  )
    fail("unidentified root source");
  if (git(ws.root, "rev-parse", "HEAD").stdout.trim() !== root.revision)
    fail("release root commit differs from checkout");
  if (
    git(
      ws.root,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ).stdout.trim()
  )
    fail("release root checkout must be clean and committed");
  if (digest(path.join(ws.root, "devenv.lock")) !== root.lockSha256)
    fail("release Nix lock differs from root");
  const expected = git(
    ws.root,
    "ls-files",
    "--",
    "installer",
    "packaging/windows",
    "ci/windows",
    "metadata",
    "kmd_render/driver-version.env",
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  if (
    !Array.isArray(root.files) ||
    !equal(root.files.map((f) => f.path).sort(), expected)
  )
    fail("root installer/install source file set differs");
  for (const f of root.files) verify_file(ws.root, f);
  for (const script of INSTALL_SCRIPTS)
    if (!expected.includes("packaging/windows/" + script))
      fail("missing shared install payload");
}
export function validate(ws, input) {
  if (
    input.schemaVersion !== 2 ||
    input.kind !== "winboat-release-input" ||
    !["release", "debug"].includes(input.configuration)
  )
    fail("unsupported release input contract");
  root_source(ws, input.root);
  if (!input.pins || !Array.isArray(input.artifacts))
    fail("release input requires pins and exact artifacts");
  for (const [name, revision] of Object.entries(input.pins))
    if (
      !ws.repos[name] ||
      revision !== ws.repos[name].pin.rev ||
      !valid_sha(revision)
    )
      fail("release source pin differs: " + name);
  if (
    !equal(
      input.artifacts.map((a) => a.provenance?.target).sort(),
      [...REQUIRED].sort(),
    )
  )
    fail("release requires exactly the declared component variants");
  const ids = new Set(),
    destinations = new Set(["manifest.json"]);
  for (const f of input.root.files.filter(
    (f) =>
      f.path.startsWith("packaging/windows/") &&
      INSTALL_SCRIPTS.includes(path.basename(f.path)),
  ))
    destinations.add(path.basename(f.path).toLowerCase());
  for (const a of input.artifacts) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(a.id) || ids.has(a.id))
      fail("duplicate/invalid artifact identity");
    ids.add(a.id);
    const m = a.provenance,
      owner = OWNERS[m.target];
    if (
      m.schemaVersion !== 1 ||
      m.kind !== "winboat-component-artifact" ||
      m.mode !== "release" ||
      m.state !== "built"
    )
      fail("dirty or unidentified component artifact");
    const productionOwner = m.target === "clvk-helios" ? "helios" : owner;
    if (
      m.repository !== "winboat-org/" + productionOwner ||
      m.sourceRepository !== "winboat-org/" + owner ||
      m.revision !== input.pins[owner]
    )
      fail("component source does not agree with release pins");
    if (
      m.rootRevision !== input.root.revision ||
      m.toolchain?.lockSha256 !== input.root.lockSha256 ||
      !sha(m.toolchain?.identity)
    )
      fail("component root/toolchain provenance differs");
    if (m.configuration !== input.configuration)
      fail("component configuration mismatch");
    const architecture = m.target.endsWith("-x86")
      ? "x86"
      : m.target === "clvk-helios" || m.target === "helios-guest-x64"
        ? "x64+x86"
        : "x64";
    if (
      m.architecture !== architecture ||
      m.abi !==
        (m.target === "qemu-helios" || m.target === "virglrenderer"
          ? "linux"
          : "msvc-mt")
    )
      fail("component architecture/ABI mismatch");
    if (
      !m.workflow ||
      !relative(m.workflow.path).startsWith(".github/workflows/") ||
      !integer(m.workflow.runId) ||
      !integer(m.workflow.runAttempt) ||
      !valid_sha(m.workflow.headSha) ||
      m.workflow.event !== "workflow_dispatch"
    )
      fail("component workflow identity is incomplete");
    const workflowOwner = m.target === "clvk-helios" ? "helios" : owner;
    if (m.workflow.headSha !== input.pins[workflowOwner])
      fail("component workflow source differs from selected owner pin");
    if (!m.dependencies || !Object.keys(m.dependencies).length)
      fail("missing component dependency provenance");
    for (const [name, revision] of Object.entries(m.dependencies))
      if (revision !== input.pins[name])
        fail("protocol/engine dependency pairing mismatch: " + name);
    const pairings = {
      "qemu-helios": ["virglrenderer", "venus-protocol"],
      virglrenderer: ["venus-protocol"],
      "mesa-guest-x64": ["venus-protocol"],
      "mesa-guest-x86": ["venus-protocol"],
      "vkd3d-engine-x64": ["dxil-spirv"],
      "vkd3d-engine-x86": ["dxil-spirv"],
      "helios-guest-x64": [
        "dxvk",
        "vkd3d-proton",
        "dxil-spirv",
        "venus-protocol",
        "mesa-helios",
      ],
    };
    for (const name of pairings[m.target] ?? [])
      if (m.dependencies[name] !== input.pins[name])
        fail("missing paired protocol/engine dependency: " + name);
    if (
      !Array.isArray(m.files) ||
      !m.files.length ||
      !Array.isArray(m.licenses) ||
      !m.licenses.length ||
      !Array.isArray(m.symbols)
    )
      fail("missing file/license/symbol provenance");
    const paths = new Set();
    for (const f of m.files) {
      relative(f.path);
      if (
        paths.has(f.path.toLowerCase()) ||
        !sha(f.sha256) ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0
      )
        fail("duplicate/invalid component file");
      paths.add(f.path.toLowerCase());
      if (f.payloadPath) {
        relative(f.payloadPath);
        if (
          !/^(payload|certificate|compatibility|licenses)\//.test(
            f.payloadPath,
          ) ||
          /\.pdb$/i.test(f.payloadPath)
        )
          fail("invalid install payload/symbol destination");
        if (destinations.has(f.payloadPath.toLowerCase()))
          fail("duplicate payload path");
        destinations.add(f.payloadPath.toLowerCase());
      }
    }
    for (const p of [...m.licenses, ...m.symbols])
      if (!paths.has(relative(p).toLowerCase()))
        fail("license/symbol absent from file table");
    if (
      !sha(a.archive.sha256) ||
      !integer(a.archive.size) ||
      !sha(a.manifest.sha256) ||
      !integer(a.manifest.size) ||
      !integer(a.githubArtifactId)
    )
      fail("missing archive/artifact identity");
    relative(a.archive.path);
    if (a.manifest.path !== "component.json")
      fail("unsupported component manifest path");
    if (
      m.target === "helios-installer" &&
      (m.installer?.interfaceVersion !== 1 ||
        m.installer?.format !== "HLIOSET2" ||
        m.installer?.sourceRevision !== input.root.revision ||
        m.installer?.sourceRepository !== ROOT_REPOSITORY)
    )
      fail("stale installer interface/source");
  }
  const requiredPaths = [
    "payload/driver/helios_kmd_render.sys",
    "payload/driver/helios_kmd_render.inf",
    "payload/driver/helios_kmd_render.cat",
    "payload/driver/helios_umd.dll",
    "payload/driver/helios_umd12.dll",
    "payload/driver/helios_umd32.dll",
    "payload/driver/helios_umd12_32.dll",
    "payload/driver/toolchain.json",
    "payload/mesa/vulkan_virtio.dll",
    "payload/mesa/libgallium_wgl.dll",
    "payload/mesa/opengl32.dll",
    "payload/mesa/x86/vulkan_virtio.dll",
    "payload/mesa/x86/libgallium_wgl.dll",
    "payload/mesa/x86/opengl32.dll",
    "payload/opencl/clvk.dll",
    "payload/loaders/vulkan-1.dll",
    "payload/loaders/x86/vulkan-1.dll",
    "payload/loaders/OpenCL.dll",
    "compatibility/DaVinci Resolve/atiadlxx.dll",
    "compatibility/DaVinci Resolve/Resolve-CompatibilityCommon.ps1",
    "compatibility/DaVinci Resolve/Install-Resolve-Compatibility.ps1",
    "compatibility/DaVinci Resolve/Uninstall-Resolve-Compatibility.ps1",
    "compatibility/DaVinci Resolve/README.md",
  ];
  for (const p of requiredPaths)
    if (!destinations.has(p.toLowerCase()))
      fail("missing required payload: " + p);
  for (const arch of ["", "x86/"])
    for (const probe of [
      "vulkan-smoke.exe",
      "vulkan-wsi-probe.exe",
      "d3d11-smoke.exe",
      "d3d12-smoke.exe",
      "d3d12-clear.exe",
      "opengl-smoke.exe",
    ])
      if (!destinations.has("payload/smoke/" + arch + probe))
        fail("missing interactive probe");
  if (!destinations.has("payload/smoke/opencl-smoke.exe"))
    fail("missing OpenCL probe");
  const signing = input.artifacts.find(
    (a) => a.provenance.target === "helios-guest-x64",
  ).provenance.signing;
  if (
    !signing ||
    signing.mode !== "test" ||
    !/^[0-9A-F]{40}$/.test(signing.thumbprint) ||
    !sha(signing.certificateSha256) ||
    !sha(signing.catalogSha256) ||
    !signing.subject ||
    !destinations.has(signing.certificate.toLowerCase())
  )
    fail("missing signing/catalog identity");
  return input;
}

async function checked_inputs(
  ws,
  manifestPath,
  artifactsDirectory,
  operationId,
) {
  const inputBytes = fs.readFileSync(path.resolve(manifestPath)),
    input = validate(
      ws,
      JSON.parse(inputBytes.toString("utf8").replace(/^\uFEFF/, "")),
    ),
    directory = path.join(ws.state, "bundles", operationId);
  mkdir(directory);
  fs.writeFileSync(path.join(directory, "release-input.json"), inputBytes, {
    flag: "wx",
  });
  const roots = {};
  for (const a of input.artifacts) {
    const archive = verify_file(artifactsDirectory, a.archive),
      target = path.join(directory, "inputs", a.id);
    if (exists(target)) fail("bundle operation directory already exists");
    const retainedPaths = new Set(
      [
        a.manifest.path,
        "build-manifest.json",
        "files/package/source-revisions.json",
        "files/package/llvm-symbol-policy.json",
        "files/HeliosSetup.exe",
        a.provenance.verifier?.path,
        ...a.provenance.files.filter((f) => f.payloadPath).map((f) => f.path),
      ].filter(Boolean),
    );
    await extract_artifact(
      archive,
      target,
      [a.manifest, ...a.provenance.files],
      retainedPaths,
    );
    if (!equal(readJSON(path.join(target, "component.json")), a.provenance))
      fail("extracted manifest disagrees with exact release input");
    const originalRow = a.provenance.files.find(
      (f) => f.path === "build-manifest.json",
    );
    if (
      !originalRow ||
      originalRow.sha256 !== a.provenance.originalManifestSha256
    )
      fail("missing original build provenance");
    const original = readJSON(path.join(target, "build-manifest.json"));
    if (
      original.schemaVersion !== 1 ||
      original.state !== "built" ||
      original.mode !== "release" ||
      original.target !== (a.provenance.buildTarget ?? a.provenance.target) ||
      original.configuration !== input.configuration ||
      !equal(original.sources, a.provenance.sourceProvenance) ||
      hash(JSON.stringify(original.toolchain)) !==
        a.provenance.toolchain.identity ||
      original.toolchain.lockSha256 !== input.root.lockSha256 ||
      original.recipe?.rootRevision !== input.root.revision ||
      original.recipe?.rootDiffSha256 !== hash("")
    )
      fail("original build source/recipe/toolchain provenance differs");
    for (const [name, source] of Object.entries(original.sources))
      if (
        source.revision !== input.pins[name] ||
        source.diffSha256 ||
        source.untracked?.length
      )
        fail("dirty original component source");
    for (const row of original.files) {
      if (row.type === "directorySymlink") {
        if (
          !["host-stack", "qemu-helios", "virglrenderer"].includes(
            original.target,
          ) ||
          !a.provenance.files.some((f) => f.path === "closure.nar")
        )
          fail("component directory link lacks its exact host closure");
        continue;
      }
      const normalized = a.provenance.files.find(
        (f) => f.path === "files/" + row.path,
      );
      if (
        !normalized ||
        normalized.size !== row.size ||
        normalized.sha256 !== row.sha256
      )
        fail("explicit artifact conversion omitted/changed a build output");
    }
    for (const row of [
      ...(original.licenses ?? []),
      ...(original.symbols ?? []),
    ])
      if (!a.provenance.files.some((f) => f.path === "files/" + row))
        fail("original license/symbol provenance omitted");
    for (const f of a.provenance.files) {
      // Other members (symbols, licenses, native closures) were hashed as
      // streams and stay inside the retained component ZIPs.
      if (!retainedPaths.has(f.path)) continue;
      const p = verify_file(target, f);
      if (
        /\.(dll|exe|sys)$/i.test(f.path) &&
        f.payloadPath &&
        pe_architecture(p) !== f.architecture
      )
        fail("actual PE architecture mismatch");
      if (/\.(dll|exe|sys)$/i.test(f.path) && f.payloadPath) {
        const inspection = original.images?.find(
          (i) => i.path === f.path.slice(6),
        );
        if (
          !inspection ||
          inspection.staticCrtVerified !== true ||
          inspection.architecture !== f.architecture
        )
          fail("missing/mismatched static CRT image inspection");
      }
    }
    roots[a.id] = target;
  }
  const driver = input.artifacts.find(
      (a) => a.provenance.target === "helios-guest-x64",
    ),
    signing = driver.provenance.signing;
  const primary = readJSON(path.join(roots[driver.id], "build-manifest.json"));
  for (const target of [
    "dxvk-engine-x64",
    "dxvk-engine-x86",
    "vkd3d-engine-x64",
    "vkd3d-engine-x86",
  ]) {
    const engine = input.artifacts.find((a) => a.provenance.target === target),
      consumed = primary.componentDependencies?.find(
        (d) => d.target === target,
      );
    if (
      !consumed ||
      consumed.manifestSha256 !== engine.provenance.originalManifestSha256
    )
      fail("primary driver did not consume the exact selected engine artifact");
  }
  const clvk = input.artifacts.find(
    (a) => a.provenance.target === "clvk-helios",
  );
  const upstream = readJSON(
    path.join(roots[clvk.id], "files/package/source-revisions.json"),
  );
  if (
    !equal(upstream, clvk.provenance.upstream) ||
    !Object.values(upstream).every(valid_sha)
  )
    fail("Khronos/LLVM upstream source provenance differs");
  const policy = readJSON(
    path.join(roots[clvk.id], "files/package/llvm-symbol-policy.json"),
  );
  if (
    policy.debugSymbols !== false ||
    policy.pdbFiles !== 0 ||
    !(policy.compilerCommandsChecked > 0)
  )
    fail("LLVM/Clang compiler symbol policy differs");
  for (const [dest, expected] of [
    [signing.certificate, signing.certificateSha256],
    ["payload/driver/helios_kmd_render.cat", signing.catalogSha256],
  ]) {
    const row = driver.provenance.files.find((f) => f.payloadPath === dest);
    if (!row || row.sha256 !== expected)
      fail("signing/catalog digest mismatch");
  }
  const installer = input.artifacts.find(
    (a) => a.provenance.target === "helios-installer",
  );
  const packer = installer.provenance.files.find(
    (f) => f.path === "files/HeliosSetup.exe",
  );
  if (
    !packer ||
    pe_architecture(path.join(roots[installer.id], packer.path)) !== "x64"
  )
    fail("missing/invalid prebuilt installer");
  const catalogVerifier = input.artifacts.find(
    (a) => a.provenance.target === "helios-catalog-verifier",
  );
  if (
    catalogVerifier.provenance.verifier?.interfaceVersion !== 1 ||
    catalogVerifier.provenance.verifier?.sourceRevision !==
      input.root.revision ||
    catalogVerifier.provenance.verifier?.sourceRepository !== ROOT_REPOSITORY
  )
    fail("stale catalog verifier interface/source");
  const verifierRow = catalogVerifier.provenance.files.find(
    (f) => f.path === catalogVerifier.provenance.verifier.path,
  );
  if (
    !verifierRow ||
    pe_architecture(path.join(roots[catalogVerifier.id], verifierRow.path)) !==
      "x64"
  )
    fail("missing/invalid prebuilt catalog verifier");
  return {
    input,
    directory,
    roots,
    packer: path.join(roots[installer.id], packer.path),
    releaseInputSha256: hash(inputBytes),
    verifier: path.join(roots[catalogVerifier.id], verifierRow.path),
  };
}
export async function verify(ws, args, operationId) {
  const result = await checked_inputs(
    ws,
    args.manifest,
    path.resolve(args.artifacts_dir),
    operationId,
  );
  const receipt = {
    kind: "bundle-verification",
    state: "verified",
    exitCode: 0,
    releaseInputSha256: result.releaseInputSha256,
    rootRevision: result.input.root.revision,
    artifactsVerified: result.input.artifacts.length,
    installed: false,
    loaded: false,
    publication: false,
    signatureVerification:
      "requires Windows catalog membership verification before packing",
    directory: result.directory,
  };
  write_json(path.join(result.directory, "verification.json"), receipt);
  ws.journal(operationId, receipt);
  return receipt;
}
export function install_manifest(input, files, packageId) {
  const driver = input.artifacts.find(
    (a) => a.provenance.target === "helios-guest-x64",
  ).provenance;
  const source = {
    helios: input.pins.helios,
    mesa: input.pins["mesa-helios"],
    dxvk: input.pins.dxvk,
    vkd3d: input.pins["vkd3d-proton"],
    clvk: input.pins["clvk-helios"],
    ...input.artifacts.find((a) => a.provenance.target === "clvk-helios")
      .provenance.upstream,
  };
  return {
    schemaVersion: 1,
    productName: driver.productName,
    publisher: driver.publisher,
    version: driver.version,
    packageId,
    architecture: "x64",
    configuration: input.configuration,
    applicationArchitectures: ["x64", "x86"],
    source,
    signing: driver.signing,
    symbolStorage: "component-artifacts",
    releaseRoot: input.root,
    artifacts: input.artifacts.map((a) => ({
      target: a.provenance.target,
      sources: a.provenance.sourceProvenance,
      manifestSha256: a.provenance.originalManifestSha256,
      repository: a.provenance.repository,
      githubArtifactId: a.githubArtifactId,
    })),
    components: {
      driver: { version: driver.version, architectures: ["x64", "x86"] },
      mesa: {
        vulkan: "Venus",
        openGL: "Zink WGL ICD",
        architectures: ["x64", "x86"],
        vulkanApiVersion: "1.4.352",
      },
      openCl: {
        implementation: "CLVK",
        onlineCompiler: true,
        architectures: ["x64"],
      },
    },
    files,
  };
}
async function prepare_inputs(ws, args, operationId) {
  const { input, directory, roots, packer, verifier, releaseInputSha256 } =
    await checked_inputs(
      ws,
      args.manifest,
      path.resolve(args.artifacts_dir),
      operationId,
    );
  const payload = path.join(directory, "payload");
  mkdir(payload);
  for (const a of input.artifacts)
    for (const f of a.provenance.files.filter((f) => f.payloadPath)) {
      const p = path.join(payload, f.payloadPath);
      mkdir(path.dirname(p));
      fs.linkSync(verify_file(roots[a.id], f), p);
      if (digest(p) !== f.sha256) fail("input changed during payload staging");
    }
  for (const script of INSTALL_SCRIPTS) {
    const row = input.root.files.find(
      (f) => f.path === "packaging/windows/" + script,
    );
    fs.copyFileSync(
      verify_file(ws.root, row),
      path.join(payload, script),
      fs.constants.COPYFILE_EXCL,
    );
    if (digest(path.join(payload, script)) !== row.sha256)
      fail("install source changed during staging");
  }
  const payloadFiles = table(payload),
    packageId =
      "helios-" + input.root.revision.slice(0, 12) + "-" + input.configuration;
  write_json(
    path.join(payload, "manifest.json"),
    install_manifest(input, payloadFiles, packageId),
  );
  const stage = path.join(directory, "stage");
  mkdir(stage);
  fs.linkSync(packer, path.join(stage, "HeliosSetup.exe"));
  fs.linkSync(verifier, path.join(stage, "VerifyCatalog.exe"));
  fs.cpSync(payload, path.join(stage, "payload"), {
    recursive: true,
    errorOnExist: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
  const request = {
    schemaVersion: 1,
    operationId,
    files: table(stage),
    signing: input.artifacts.find((a) => a.provenance.signing).provenance
      .signing,
    branding: Object.fromEntries(
      ["version", "productName", "publisher"].map((k) => [
        k,
        input.artifacts.find((a) => a.provenance.target === "helios-guest-x64")
          .provenance[k],
      ]),
    ),
  };
  write_json(path.join(directory, "pack-request.json"), request);
  root_source(ws, input.root);
  const archive = path.join(directory, "stage.zip");
  await create_zip(
    archive,
    request.files.map((f) => [path.join(stage, f.path), f.path]),
  );
  request.archiveSha256 = digest(archive);
  request.archiveSize = fs.statSync(archive).size;
  const requestPath = path.join(directory, "pack-request.json");
  write_json(requestPath, request);
  const preparationDirectory = args.preparation_dir
    ? path.resolve(args.preparation_dir)
    : path.join(directory, "packing-input");
  if (
    exists(preparationDirectory) &&
    fs.readdirSync(preparationDirectory).length
  )
    fail("packing preparation requires a clean directory");
  mkdir(preparationDirectory);
  for (const [source, name] of [
    [archive, "stage.zip"],
    [requestPath, "pack-request.json"],
    [path.join(directory, "release-input.json"), "release-input.json"],
  ])
    fs.copyFileSync(
      source,
      path.join(preparationDirectory, name),
      fs.constants.COPYFILE_EXCL,
    );
  const preparation = {
    schemaVersion: 1,
    kind: "winboat-packing-input",
    operationId,
    rootRevision: input.root.revision,
    releaseInputSha256,
    requestSha256: digest(requestPath),
    payloadDigest: hash(JSON.stringify(table(payload))),
  };
  write_json(path.join(preparationDirectory, "preparation.json"), preparation);
  return {
    input,
    directory,
    roots,
    packer,
    verifier,
    releaseInputSha256,
    payload,
    packageId,
    archive,
    request,
    requestPath,
    preparationDirectory,
    preparation,
  };
}
export async function prepare(ws, args, operationId) {
  const prepared = await prepare_inputs(ws, args, operationId);
  const receipt = {
    kind: "bundle-preparation",
    state: "prepared",
    exitCode: 0,
    operationId,
    preparationDirectory: prepared.preparationDirectory,
    releaseInputSha256: prepared.releaseInputSha256,
    requestSha256: prepared.preparation.requestSha256,
    payloadDigest: prepared.preparation.payloadDigest,
  };
  ws.journal(operationId, receipt);
  return receipt;
}
export async function assemble(ws, args, operationId) {
  const prepared = await prepare_inputs(ws, args, operationId);
  const { input, directory, request, archive, releaseInputSha256 } = prepared;
  const guestId = identity(),
    remote = windows.ROOT + "\\jobs\\" + guestId;
  ws.journal(operationId, {
    kind: "bundle",
    state: "staging",
    name: args.name,
    guestJobId: guestId,
    releaseInputSha256,
    directory,
  });
  await windows.submit(
    ws,
    args.name,
    guestId,
    path.join(env.WB_DEVBOX_PAYLOADS, "Bundle.ps1"),
    "system",
    ["-Specification", remote + "\\pack-request.json"],
    false,
    { kind: "release-packing", releaseInputSha256 },
    {
      "pack-request.json": path.join(directory, "pack-request.json"),
      "stage.zip": archive,
    },
  );
  await windows.wait(ws, args.name, guestId);
  const resultPath = path.join(directory, "pack-result.json");
  windows.download(ws, args.name, remote + "\\pack-result.json", resultPath);
  const result = readJSON(resultPath);
  if (
    result.file?.path !==
    "C:\\WinBoatDev\\bundles\\" + operationId + "\\HeliosSetup.exe"
  )
    fail("packer receipt path mismatch");
  const packedDirectory = path.join(directory, "packed-output");
  mkdir(packedDirectory);
  const packed = path.join(packedDirectory, "HeliosSetup.exe");
  windows.download(ws, args.name, result.file.path, packed, result.file);
  const receipt = await finish_candidate(
    ws,
    args,
    operationId,
    prepared,
    result,
    packedDirectory,
    operationId,
    digest(prepared.requestPath),
  );
  receipt.guestJobId = guestId;
  return receipt;
}
export async function complete(ws, args, operationId) {
  const directory = path.resolve(args.preparation_dir);
  const metadata = readJSON(safe_file(directory, "preparation.json"));
  const requestPath = safe_file(directory, "pack-request.json");
  const request = readJSON(requestPath);
  if (
    metadata.schemaVersion !== 1 ||
    metadata.kind !== "winboat-packing-input" ||
    !/^op-[0-9a-f]{32}$/.test(metadata.operationId ?? "") ||
    request.operationId !== metadata.operationId ||
    metadata.requestSha256 !== digest(requestPath)
  )
    fail("packing preparation identity mismatch");
  const prepared = await prepare_inputs(
    ws,
    { ...args, preparation_dir: undefined },
    operationId,
  );
  if (
    metadata.rootRevision !== prepared.input.root.revision ||
    metadata.releaseInputSha256 !== prepared.releaseInputSha256 ||
    digest(safe_file(directory, "release-input.json")) !==
      prepared.releaseInputSha256 ||
    metadata.payloadDigest !== prepared.preparation.payloadDigest ||
    !equal(request.files, prepared.request.files) ||
    !equal(request.signing, prepared.request.signing) ||
    !equal(request.branding, prepared.request.branding)
  )
    fail("packing preparation differs from verified release inputs");
  verify_file(directory, {
    path: "stage.zip",
    sha256: request.archiveSha256,
    size: request.archiveSize,
  });
  const packedDirectory = path.resolve(args.packed_dir);
  const result = readJSON(safe_file(packedDirectory, "pack-result.json"));
  return finish_candidate(
    ws,
    args,
    operationId,
    prepared,
    result,
    packedDirectory,
    metadata.operationId,
    metadata.requestSha256,
  );
}
async function finish_candidate(
  ws,
  args,
  operationId,
  prepared,
  result,
  packedDirectory,
  packingOperationId,
  requestSha256,
) {
  const { input, directory, payload, packageId, releaseInputSha256 } = prepared;
  const signing = prepared.request.signing;
  if (
    result.schemaVersion !== 1 ||
    result.operationId !== packingOperationId ||
    result.state !== "packed" ||
    result.inputSha256 !== requestSha256 ||
    result.signatures?.catalogMembership !== "verified" ||
    result.signatures?.catalogSigner !== signing.thumbprint ||
    result.signatures?.certificateSha256 !== signing.certificateSha256 ||
    result.signatures?.catalogSha256 !== signing.catalogSha256
  )
    fail("packer receipt identity/signature mismatch");
  const packed = verify_file(packedDirectory, {
    ...result.file,
    path: "HeliosSetup.exe",
  });
  if (pe_architecture(packed) !== "x64")
    fail("packed installer architecture mismatch");
  await verify_packed_payload(packed, table(payload), {
    size: fs.statSync(prepared.packer).size,
    sha256: digest(prepared.packer),
  });
  root_source(ws, input.root);
  const output = path.join(ws.out, "bundles", operationId);
  mkdir(output);
  const exe = path.join(output, "HeliosSetup.exe");
  fs.copyFileSync(
    packed,
    exe,
    fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
  );
  fs.cpSync(payload, path.join(output, "payload"), {
    recursive: true,
    errorOnExist: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
  const retained = path.join(output, "component-artifacts");
  mkdir(retained);
  for (const a of input.artifacts)
    fs.copyFileSync(
      verify_file(path.resolve(args.artifacts_dir), a.archive),
      path.join(retained, a.id + ".zip"),
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
  const release = {
    schemaVersion: 1,
    kind: "winboat-release-candidate",
    state: "candidate",
    operationId,
    packingOperationId,
    requestSha256,
    packageId,
    root: input.root,
    releaseInputSha256,
    artifacts: input.artifacts,
    payloadFiles: table(payload),
    packer: input.artifacts.find((a) => a.provenance.installer).provenance
      .installer,
    signatures: result.signatures,
    container: {
      format: "HLIOSET2",
      file: {
        path: "HeliosSetup.exe",
        size: fs.statSync(exe).size,
        sha256: digest(exe),
      },
    },
    reproducibility: {
      payloadDigest: hash(JSON.stringify(table(payload))),
      container:
        "Compare exact outputs; signing and packer metadata can vary. No byte reproducibility claim.",
    },
    installed: false,
    loaded: false,
    published: false,
  };
  write_json(path.join(output, "release-manifest.json"), release);
  ws.journal(operationId, {
    kind: "bundle",
    state: "succeeded",
    exitCode: 0,
    manifest: path.join(output, "release-manifest.json"),
    packingOperationId,
    directory,
  });
  return {
    state: "candidate",
    exitCode: 0,
    manifest: path.join(output, "release-manifest.json"),
    installer: exe,
    payloadDigest: release.reproducibility.payloadDigest,
    packingOperationId,
    installed: false,
    loaded: false,
    published: false,
  };
}
export function verify_container(p) {
  const fd = fs.openSync(p, "r"),
    size = fs.statSync(p).size,
    footer = Buffer.alloc(64);
  try {
    if (
      size < 64 ||
      fs.readSync(fd, footer, 0, 64, size - 64) !== 64 ||
      footer.toString("ascii", 56) !== "HLIOSET2"
    )
      fail("stale or corrupt installer container");
    const offset = Number(footer.readBigUInt64LE(0)),
      length = Number(footer.readBigUInt64LE(8)),
      header = Number(footer.readBigUInt64LE(16));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset + length + 64 !== size ||
      header > length ||
      header < 4
    )
      fail("invalid installer footer");
    const h = run([
      env.WB_NODE,
      "--input-type=module",
      "-e",
      "import fs from 'node:fs';import crypto from 'node:crypto';const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(process.argv[1],{start:Number(process.argv[2]),end:Number(process.argv[3])-1}))h.update(b);console.log(h.digest('hex'));",
      p,
      offset,
      offset + length,
    ]).stdout.trim();
    if (h !== footer.subarray(24, 56).toString("hex"))
      fail("installer container hash mismatch");
  } finally {
    fs.closeSync(fd);
  }
}

export async function verify_packed_payload(p, expected, stub) {
  verify_container(p);
  const fd = fs.openSync(p, "r");
  let offset, length, headerLength, entries;
  try {
    const footer = Buffer.alloc(64);
    fs.readSync(fd, footer, 0, 64, fs.statSync(p).size - 64);
    offset = Number(footer.readBigUInt64LE(0));
    length = Number(footer.readBigUInt64LE(8));
    headerLength = Number(footer.readBigUInt64LE(16));
    if (
      offset !== stub.size ||
      headerLength !==
        4 + expected.reduce((n, f) => n + 10 + Buffer.byteLength(f.path), 0)
    )
      fail("packed installer source/header differs from verified inputs");
    const prefix = Buffer.alloc(offset);
    if (
      fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length ||
      hash(prefix) !== stub.sha256
    )
      fail("packed installer stub differs from the prebuilt component");
    const header = Buffer.alloc(headerLength);
    if (
      fs.readSync(fd, header, 0, headerLength, offset) !== headerLength ||
      header.readUInt32LE(0) !== expected.length
    )
      fail("packed payload header differs from verified file set");
    const known = new Map(expected.map((f) => [f.path, f]));
    entries = [];
    let cursor = 4;
    while (cursor < header.length) {
      if (cursor + 2 > header.length) fail("truncated packed payload header");
      const nameLength = header.readUInt16LE(cursor);
      cursor += 2;
      if (cursor + nameLength + 8 > header.length)
        fail("truncated packed payload entry");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        header.subarray(cursor, cursor + nameLength),
      );
      cursor += nameLength;
      const size = Number(header.readBigUInt64LE(cursor));
      cursor += 8;
      const row = known.get(name);
      if (!row || size !== row.size)
        fail("packed payload file differs from verified inputs");
      known.delete(name);
      entries.push(row);
    }
    if (known.size) fail("packed payload omits verified files");
  } finally {
    fs.closeSync(fd);
  }
  const decoder = spawn(
    env.WB_XZ,
    ["--decompress", "--stdout", "--memlimit-decompress=128MiB"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let error = "";
  decoder.stderr.on("data", (b) => {
    if (error.length < 8192) error += b;
  });
  const exited = new Promise((resolve, reject) => {
    decoder.once("error", reject);
    decoder.once("close", (code) =>
      code
        ? reject(
            new Failure("packed payload decompression failed: " + error, 74),
          )
        : resolve(),
    );
  });
  // Attach a rejection handler while reading stdout; the final await retains it.
  exited.catch(() => {});
  const compressed = fs.createReadStream(p, {
    start: offset + headerLength,
    end: offset + length - 1,
  });
  compressed.on("error", (e) => decoder.stdin.destroy(e));
  decoder.stdin.on("error", () => {});
  compressed.pipe(decoder.stdin);
  let index = 0,
    consumed = 0,
    digestState = crypto.createHash("sha256");
  const finishEmpty = () => {
    while (index < entries.length && consumed === entries[index].size) {
      if (digestState.digest("hex") !== entries[index].sha256)
        fail("packed payload hash differs from verified inputs");
      index++;
      consumed = 0;
      digestState = crypto.createHash("sha256");
    }
  };
  try {
    finishEmpty();
    for await (const chunk of decoder.stdout) {
      let cursor = 0;
      while (cursor < chunk.length) {
        if (index >= entries.length)
          fail("packed payload contains unexpected bytes");
        const take = Math.min(
          entries[index].size - consumed,
          chunk.length - cursor,
        );
        digestState.update(chunk.subarray(cursor, cursor + take));
        cursor += take;
        consumed += take;
        finishEmpty();
      }
    }
    await exited;
    if (index !== entries.length) fail("packed payload is truncated");
  } finally {
    compressed.destroy();
    if (decoder.exitCode === null) decoder.kill();
  }
}

function api(endpoint) {
  return JSON.parse(run([env.WB_GH, "api", endpoint]).stdout);
}
function check_remote(a) {
  const m = a.provenance;
  if (
    !repo(m.repository) ||
    !integer(a.githubArtifactId) ||
    !integer(m.workflow.runId)
  )
    fail("invalid GitHub artifact selector");
  const metadata = api(
      "repos/" + m.repository + "/actions/artifacts/" + a.githubArtifactId,
    ),
    workflow = api(
      "repos/" + m.repository + "/actions/runs/" + m.workflow.runId,
    );
  if (
    metadata.id !== a.githubArtifactId ||
    metadata.expired ||
    metadata.digest !== "sha256:" + a.archive.sha256 ||
    metadata.workflow_run?.id !== m.workflow.runId ||
    metadata.workflow_run?.head_sha !== m.workflow.headSha ||
    workflow.run_attempt !== m.workflow.runAttempt ||
    workflow.head_sha !== m.workflow.headSha ||
    workflow.path !== m.workflow.path ||
    workflow.event !== "workflow_dispatch" ||
    workflow.conclusion !== "success" ||
    workflow.head_repository?.full_name !== m.repository
  )
    fail("expired, failed, forked or mismatched hosted artifact");
  return metadata;
}
async function download_archive(repository, artifactId, destination) {
  const fd = fs.openSync(destination, "wx");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        env.WB_GH,
        [
          "api",
          "repos/" + repository + "/actions/artifacts/" + artifactId + "/zip",
        ],
        { stdio: ["ignore", fd, "pipe"] },
      );
      let error = "";
      child.stderr.on("data", (b) => {
        if (error.length < 8192) error += b;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code
          ? reject(
              new Failure("exact artifact download failed: " + error, code),
            )
          : resolve(),
      );
    });
  } finally {
    fs.closeSync(fd);
  }
}
export async function fetch_artifacts(ws, args, operationId) {
  const input = validate(ws, readJSON(args.manifest)),
    directory = path.resolve(args.artifacts_dir);
  if (exists(directory) && fs.readdirSync(directory).length)
    fail("artifact download requires a clean empty directory");
  mkdir(directory);
  for (const a of input.artifacts) {
    check_remote(a);
    const p = path.join(directory, relative(a.archive.path));
    mkdir(path.dirname(p));
    await download_archive(a.provenance.repository, a.githubArtifactId, p);
    verify_file(directory, a.archive);
  }
  const result = {
    state: "downloaded",
    exitCode: 0,
    artifacts: input.artifacts.length,
    directory,
    releaseInputSha256: digest(args.manifest),
  };
  ws.journal(operationId, { kind: "bundle-fetch", ...result });
  return result;
}
export async function lock(ws, args, operationId) {
  const selection = readJSON(args.selection);
  if (
    selection.schemaVersion !== 1 ||
    !valid_sha(selection.rootRevision) ||
    !Array.isArray(selection.artifacts) ||
    !["release", "debug"].includes(selection.configuration)
  )
    fail("invalid exact artifact selection");
  const directory = path.resolve(args.artifacts_dir);
  if (exists(directory) && fs.readdirSync(directory).length)
    fail("lock requires a clean download directory");
  mkdir(directory);
  const input = {
    schemaVersion: 2,
    kind: "winboat-release-input",
    configuration: selection.configuration,
    root: {
      repository: ROOT_REPOSITORY,
      revision: selection.rootRevision,
      lockSha256: digest(path.join(ws.root, "devenv.lock")),
      files: [],
    },
    pins: Object.fromEntries(
      Object.entries(ws.repos).map(([name, r]) => [name, r.pin.rev]),
    ),
    artifacts: [],
  };
  const rootPaths = git(
    ws.root,
    "ls-files",
    "--",
    "installer",
    "packaging/windows",
    "ci/windows",
    "metadata",
    "kmd_render/driver-version.env",
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  input.root.files = rootPaths.map((p) => ({
    path: p,
    size: fs.statSync(safe_file(ws.root, p)).size,
    sha256: digest(path.join(ws.root, p)),
  }));
  root_source(ws, input.root);
  const seen = new Set();
  for (const s of selection.artifacts) {
    if (
      !repo(s.repository) ||
      !integer(s.artifactId) ||
      !integer(s.runId) ||
      !integer(s.runAttempt) ||
      seen.has(s.artifactId + ":" + s.repository)
    )
      fail("invalid/duplicate exact artifact selector");
    seen.add(s.artifactId + ":" + s.repository);
    const metadata = api(
      "repos/" + s.repository + "/actions/artifacts/" + s.artifactId,
    );
    if (
      metadata.expired ||
      !/^sha256:[0-9a-f]{64}$/.test(metadata.digest ?? "")
    )
      fail("artifact expired or has no archive digest");
    const archive = {
      path: "artifact-" + input.artifacts.length + ".zip",
      sha256: metadata.digest.slice(7),
      size: metadata.size_in_bytes,
    };
    await download_archive(
      s.repository,
      s.artifactId,
      path.join(directory, archive.path),
    );
    verify_file(directory, archive);
    const metadataFile = await read_metadata(
        path.join(directory, archive.path),
        "component.json",
      ),
      parsed = {
        provenance: metadataFile.value,
        manifest: metadataFile.record,
      },
      a = {
        id: parsed.provenance.target,
        githubArtifactId: s.artifactId,
        archive,
        ...parsed,
      };
    if (
      a.provenance.repository !== s.repository ||
      a.provenance.workflow.runId !== s.runId ||
      a.provenance.workflow.runAttempt !== s.runAttempt
    )
      fail("downloaded artifact differs from selector");
    check_remote(a);
    input.artifacts.push(a);
  }
  validate(ws, input);
  const output = path.join(ws.out, "release-inputs", operationId + ".json");
  write_json(output, input);
  const result = {
    state: "locked",
    exitCode: 0,
    manifest: output,
    manifestSha256: digest(output),
    directory,
  };
  ws.journal(operationId, { kind: "bundle-lock", ...result });
  return result;
}
export async function dispatch(ws, args, operationId) {
  return { verify, prepare, complete, assemble, fetch: fetch_artifacts, lock }[
    args.action
  ](ws, args, operationId);
}
