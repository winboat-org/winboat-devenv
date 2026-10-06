import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { mcp } from "./helpers.mjs";
import {
  fs,
  path,
  git,
  hash,
  digest,
  write_json,
  identity,
  env,
  readJSON,
  run,
} from "../tools/wb/common.mjs";
import { create_zip } from "../tools/wb/archives.mjs";
import * as bundles from "../tools/wb/bundles.mjs";

function write(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
function pe(architecture = "x64") {
  const data = Buffer.alloc(128);
  data.write("MZ");
  data.writeUInt32LE(80, 60);
  data.writeUInt32LE(0x4550, 80);
  data.writeUInt16LE(architecture === "x64" ? 0x8664 : 0x14c, 84);
  return data;
}
function packed_fixture(payloadDirectory) {
  const rows = bundles.table(payloadDirectory),
    count = Buffer.alloc(4);
  count.writeUInt32LE(rows.length);
  const header = Buffer.concat([
    count,
    ...rows.map((f) => {
      const name = Buffer.from(f.path),
        row = Buffer.alloc(2 + name.length + 8);
      row.writeUInt16LE(name.length);
      name.copy(row, 2);
      row.writeBigUInt64LE(BigInt(f.size), 2 + name.length);
      return row;
    }),
  ]);
  const compressed = spawnSync(env.WB_XZ, ["--compress", "--stdout"], {
    input: Buffer.concat(
      rows.map((f) => fs.readFileSync(path.join(payloadDirectory, f.path))),
    ),
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(compressed.status, 0, compressed.stderr.toString());
  const body = Buffer.concat([header, compressed.stdout]),
    footer = Buffer.alloc(64);
  footer.writeBigUInt64LE(128n);
  footer.writeBigUInt64LE(BigInt(body.length), 8);
  footer.writeBigUInt64LE(BigInt(header.length), 16);
  Buffer.from(hash(body), "hex").copy(footer, 24);
  footer.write("HLIOSET2", 56);
  return Buffer.concat([pe(), body, footer]);
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb bundle spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = {
    root,
    state: path.join(root, ".state"),
    out: path.join(root, "out"),
    repos: {},
    journal(id, result) {
      write_json(path.join(this.state, "operations", id + ".json"), result);
    },
  };
  write(path.join(root, ".gitignore"), "/.state/\n/out/\n/artifacts/\n");
  write(path.join(root, "devenv.lock"), "genuine fixture lock\n");
  write(path.join(root, "installer/source.rs"), "fixture installer\n");
  for (const name of bundles.INSTALL_SCRIPTS)
    write(
      path.join(root, "packaging/windows", name),
      "# fixture shared script\n",
    );
  git(root, "init", "-b", "main");
  git(root, "add", ".gitignore", "devenv.lock", "installer", "packaging");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture immutable source",
  );
  const revision = git(root, "rev-parse", "HEAD").stdout.trim(),
    lockSha256 = digest(path.join(root, "devenv.lock"));
  const names = [
      ...new Set([
        ...Object.values(bundles.OWNERS),
        "venus-protocol",
        "dxil-spirv",
      ]),
    ],
    pins = {};
  names.forEach((n, i) => {
    pins[n] = (i + 1).toString(16).padStart(40, "0");
    ws.repos[n] = { pin: { rev: pins[n] } };
  });
  const input = {
    schemaVersion: 2,
    kind: "winboat-release-input",
    configuration: "release",
    root: {
      repository: bundles.ROOT_REPOSITORY,
      revision,
      lockSha256,
      files: bundles
        .table(path.join(root, "installer"))
        .map((f) => ({ ...f, path: "installer/" + f.path }))
        .concat(
          bundles
            .table(path.join(root, "packaging/windows"))
            .map((f) => ({ ...f, path: "packaging/windows/" + f.path })),
        ),
    },
    pins,
    artifacts: [],
  };
  for (const target of bundles.REQUIRED) {
    const owner = bundles.OWNERS[target],
      producer = target === "clvk-helios" ? "helios" : owner;
    const directory = path.join(root, ".state", "sources", target);
    fs.mkdirSync(directory, { recursive: true });
    const m = {
      schemaVersion: 1,
      kind: "winboat-component-artifact",
      state: "built",
      mode: "release",
      target,
      repository: "winboat-org/" + producer,
      sourceRepository: "winboat-org/" + owner,
      revision: pins[owner],
      rootRevision: revision,
      configuration: "release",
      architecture: target.endsWith("-x86")
        ? "x86"
        : ["helios-guest-x64", "clvk-helios"].includes(target)
          ? "x64+x86"
          : "x64",
      abi: ["qemu-helios", "virglrenderer"].includes(target)
        ? "linux"
        : "msvc-mt",
      dependencies: { ...pins },
      toolchain: { lockSha256, identity: hash(target) },
      workflow: {
        path: ".github/workflows/build-" + target + ".yml",
        runId: 100,
        runAttempt: 1,
        headSha: pins[producer],
        event: "workflow_dispatch",
      },
      files: [],
      licenses: ["files/licenses/NOTICE"],
      symbols: ["files/symbols/runtime.pdb"],
    };
    const add = (p, data, payloadPath, architecture) => {
      write(path.join(directory, p), data);
      m.files.push({
        path: p,
        size: data.length,
        sha256: digest(path.join(directory, p)),
        ...(payloadPath ? { payloadPath } : {}),
        ...(architecture ? { architecture } : {}),
      });
    };
    const image = (name, dest, arch = "x64") =>
      add("files/" + name, pe(arch), dest, arch);
    add(
      "files/licenses/NOTICE",
      Buffer.from("Fixture license attribution\n"),
      "licenses/" + target + "/NOTICE",
    );
    add("files/symbols/runtime.pdb", Buffer.from("runtime symbols"));
    if (target === "helios-guest-x64") {
      for (const name of [
        "helios_kmd_render.sys",
        "helios_umd.dll",
        "helios_umd12.dll",
        "helios_umd32.dll",
        "helios_umd12_32.dll",
      ])
        image(
          name,
          "payload/driver/" + name,
          name.includes("32") ? "x86" : "x64",
        );
      add(
        "files/driver.inf",
        Buffer.from("fixture INF"),
        "payload/driver/helios_kmd_render.inf",
      );
      add(
        "files/driver.cat",
        Buffer.from("fixture signed catalog"),
        "payload/driver/helios_kmd_render.cat",
      );
      add(
        "files/test.cer",
        Buffer.from("fixture test certificate"),
        "certificate/helios-dev-test.cer",
      );
      add(
        "files/toolchain.json",
        Buffer.from("{}"),
        "payload/driver/toolchain.json",
      );
      m.signing = {
        mode: "test",
        thumbprint: "A".repeat(40),
        subject: "CN=Fixture",
        certificate: "certificate/helios-dev-test.cer",
        certificateSha256: hash("fixture test certificate"),
        catalogSha256: hash("fixture signed catalog"),
      };
      m.productName = "Helios";
      m.publisher = "WinBoat";
      m.version = "1.2.3.4";
    }
    if (target.startsWith("mesa-guest-"))
      for (const name of [
        "vulkan_virtio.dll",
        "libgallium_wgl.dll",
        "opengl32.dll",
      ])
        image(
          name,
          "payload/mesa/" + (target.endsWith("x86") ? "x86/" : "") + name,
          target.endsWith("x86") ? "x86" : "x64",
        );
    if (target === "clvk-helios") {
      image("clvk.dll", "payload/opencl/clvk.dll");
      image("vulkan-1.dll", "payload/loaders/vulkan-1.dll");
      image("x86/vulkan-1.dll", "payload/loaders/x86/vulkan-1.dll", "x86");
      image("OpenCL.dll", "payload/loaders/OpenCL.dll");
      for (const arch of ["x64", "x86"])
        for (const name of [
          "vulkan-smoke.exe",
          "vulkan-wsi-probe.exe",
          "d3d11-smoke.exe",
          "d3d12-smoke.exe",
          "d3d12-clear.exe",
          "opengl-smoke.exe",
        ])
          image(
            arch + "/" + name,
            "payload/smoke/" + (arch === "x86" ? "x86/" : "") + name,
            arch,
          );
      image("opencl-smoke.exe", "payload/smoke/opencl-smoke.exe");
      m.upstream = {
        vulkanLoader: "1".repeat(40),
        vulkanHeaders: "2".repeat(40),
        openClLoader: "3".repeat(40),
        openClHeaders: "4".repeat(40),
      };
      add(
        "files/package/source-revisions.json",
        Buffer.from(JSON.stringify(m.upstream)),
      );
      add(
        "files/package/llvm-symbol-policy.json",
        Buffer.from(
          JSON.stringify({
            debugSymbols: false,
            pdbFiles: 0,
            compilerCommandsChecked: 12,
          }),
        ),
      );
    }
    if (target === "helios-compatibility") {
      image("atiadlxx.dll", "compatibility/DaVinci Resolve/atiadlxx.dll");
      for (const name of [
        "Resolve-CompatibilityCommon.ps1",
        "Install-Resolve-Compatibility.ps1",
        "Uninstall-Resolve-Compatibility.ps1",
        "README.md",
      ])
        add(
          "files/" + name,
          Buffer.from("fixture compatibility"),
          "compatibility/DaVinci Resolve/" + name,
        );
    }
    if (target === "helios-catalog-verifier") {
      image("VerifyCatalog.exe", null);
      m.verifier = {
        interfaceVersion: 1,
        path: "files/VerifyCatalog.exe",
        sourceRevision: revision,
        sourceRepository: bundles.ROOT_REPOSITORY,
      };
    }
    if (target === "helios-installer") {
      image("HeliosSetup.exe", null);
      m.installer = {
        interfaceVersion: 1,
        format: "HLIOSET2",
        sourceRevision: revision,
        sourceRepository: bundles.ROOT_REPOSITORY,
      };
    }
    if (["qemu-helios", "virglrenderer"].includes(target))
      add("closure.nar", Buffer.from("fixture complete closure"));
    m.sourceProvenance = Object.fromEntries(
      Object.entries(pins).map(([name, revision]) => [
        name,
        { revision, diffSha256: null, untracked: [] },
      ]),
    );
    const original = {
      schemaVersion: 1,
      state: "built",
      mode: "release",
      target,
      configuration: "release",
      sources: m.sourceProvenance,
      toolchain: { lockSha256, observedTarget: target },
      recipe: { rootRevision: revision, rootDiffSha256: hash("") },
      files: m.files
        .filter((f) => f.path.startsWith("files/"))
        .map((f) => ({
          path: f.path.slice(6),
          size: f.size,
          sha256: f.sha256,
        })),
      licenses: m.licenses.map((p) => p.slice(6)),
      symbols: m.symbols.map((p) => p.slice(6)),
      images: m.files
        .filter((f) => f.architecture)
        .map((f) => ({
          path: f.path.slice(6),
          architecture: f.architecture,
          staticCrtVerified: true,
        })),
    };
    m.toolchain.identity = hash(JSON.stringify(original.toolchain));
    write_json(path.join(directory, "build-manifest.json"), original);
    add(
      "build-manifest.json",
      fs.readFileSync(path.join(directory, "build-manifest.json")),
    );
    m.originalManifestSha256 = digest(
      path.join(directory, "build-manifest.json"),
    );
    write_json(path.join(directory, "component.json"), m);
    const archivePath = target + ".zip",
      artifactDirectory = path.join(root, "artifacts");
    fs.mkdirSync(artifactDirectory, { recursive: true });
    await create_zip(path.join(artifactDirectory, archivePath), [
      [path.join(directory, "component.json"), "component.json"],
      ...m.files.map((f) => [path.join(directory, f.path), f.path]),
    ]);
    input.artifacts.push({
      id: target,
      githubArtifactId: input.artifacts.length + 1,
      provenance: m,
      archive: {
        path: archivePath,
        size: fs.statSync(path.join(artifactDirectory, archivePath)).size,
        sha256: digest(path.join(artifactDirectory, archivePath)),
      },
      manifest: {
        path: "component.json",
        size: fs.statSync(path.join(directory, "component.json")).size,
        sha256: digest(path.join(directory, "component.json")),
      },
    });
  }
  const primary = input.artifacts[0],
    primaryDir = path.join(root, ".state/sources", primary.id);
  const original = readJSON(path.join(primaryDir, "build-manifest.json"));
  original.componentDependencies = input.artifacts
    .filter((a) => a.id.includes("engine-"))
    .map((a) => ({
      target: a.id,
      manifestSha256: a.provenance.originalManifestSha256,
    }));
  write_json(path.join(primaryDir, "build-manifest.json"), original);
  primary.provenance.originalManifestSha256 = digest(
    path.join(primaryDir, "build-manifest.json"),
  );
  Object.assign(
    primary.provenance.files.find((f) => f.path === "build-manifest.json"),
    {
      size: fs.statSync(path.join(primaryDir, "build-manifest.json")).size,
      sha256: primary.provenance.originalManifestSha256,
    },
  );
  await rewrite_artifact(
    { ws, artifacts_dir: path.join(root, "artifacts") },
    primary,
  );
  const manifest = path.join(root, ".state/input.json");
  write_json(manifest, input);
  return { ws, input, manifest, artifacts_dir: path.join(root, "artifacts") };
}
async function rewrite_artifact(f, a) {
  const directory = path.join(f.ws.state, "sources", a.id),
    archive = path.join(f.artifacts_dir, a.archive.path);
  write_json(path.join(directory, "component.json"), a.provenance);
  fs.unlinkSync(archive);
  await create_zip(archive, [
    [path.join(directory, "component.json"), "component.json"],
    ...a.provenance.files.map((r) => [path.join(directory, r.path), r.path]),
  ]);
  a.manifest.sha256 = digest(path.join(directory, "component.json"));
  a.manifest.size = fs.statSync(path.join(directory, "component.json")).size;
  a.archive.sha256 = digest(archive);
  a.archive.size = fs.statSync(archive).size;
}
test("exact archives verify; install schema keeps symbols outside payload and all source identities", async (t) => {
  const f = await fixture(t),
    result = await bundles.verify(f.ws, f, identity());
  assert.equal(result.artifactsVerified, f.input.artifacts.length);
  assert.equal(result.publication, false);
  assert.equal(result.installed, false);
  const m = bundles.install_manifest(f.input, [], "fixture");
  assert.equal(m.schemaVersion, 1);
  assert.deepEqual(m.applicationArchitectures, ["x64", "x86"]);
  assert.equal(m.source.dxvk, f.input.pins.dxvk);
  assert.equal(m.symbolStorage, "component-artifacts");
  assert.equal(m.components.mesa.vulkanApiVersion, "1.4.352");
  assert.equal(
    m.artifacts.filter((a) => a.target.startsWith("mesa-guest-")).length,
    2,
  );
});
test("all incompatible release identities fail before a guest task", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["missing artifact", (m) => m.artifacts.pop(), /exactly/],
    [
      "wrong commit",
      (m) => (m.artifacts[0].provenance.revision = "f".repeat(40)),
      /source/,
    ],
    [
      "wrong configuration",
      (m) => (m.artifacts[0].provenance.configuration = "debug"),
      /configuration/,
    ],
    [
      "x86/x64 mismatch",
      (m) => (m.artifacts[1].provenance.architecture = "x86"),
      /architecture/,
    ],
    [
      "protocol pairing",
      (m) =>
        (m.artifacts[1].provenance.dependencies["venus-protocol"] = "f".repeat(
          40,
        )),
      /pairing/,
    ],
    [
      "missing protocol provenance",
      (m) => delete m.artifacts[1].provenance.dependencies["venus-protocol"],
      /paired/,
    ],
    [
      "missing license",
      (m) => (m.artifacts[0].provenance.licenses = []),
      /license/,
    ],
    [
      "symbol lost",
      (m) => (m.artifacts[0].provenance.symbols = ["absent.pdb"]),
      /symbol/,
    ],
    [
      "duplicate payload path",
      (m) =>
        (m.artifacts[1].provenance.files[0].payloadPath =
          m.artifacts[0].provenance.files[0].payloadPath),
      /duplicate payload/,
    ],
    [
      "stale installer",
      (m) =>
        (m.artifacts.find(
          (a) => a.provenance.installer,
        ).provenance.installer.interfaceVersion = 0),
      /stale/,
    ],
    [
      "installer source",
      (m) =>
        (m.artifacts.find(
          (a) => a.provenance.installer,
        ).provenance.installer.sourceRevision = "f".repeat(40)),
      /source/,
    ],
    [
      "unidentified workflow",
      (m) => (m.artifacts[0].provenance.workflow.runId = 0),
      /workflow/,
    ],
    [
      "fork workflow",
      (m) => (m.artifacts[0].provenance.workflow.event = "pull_request"),
      /workflow/,
    ],
    [
      "dirty artifact",
      (m) => (m.artifacts[0].provenance.mode = "development"),
      /dirty/,
    ],
    ["root pin", (m) => (m.pins.dxvk = "f".repeat(40)), /pin/],
    ["root lock", (m) => (m.root.lockSha256 = "f".repeat(64)), /lock/],
    [
      "path traversal",
      (m) => (m.artifacts[0].archive.path = "../escape.zip"),
      /path/,
    ],
    [
      "case alias",
      (m) =>
        m.artifacts[0].provenance.files.push({
          ...m.artifacts[0].provenance.files[0],
          path: m.artifacts[0].provenance.files[0].path.toUpperCase(),
        }),
      /duplicate/,
    ],
  ];
  for (const [name, mutate, expected] of cases)
    await t.test(name, () => {
      const m = structuredClone(f.input);
      mutate(m);
      assert.throws(() => bundles.validate(f.ws, m), expected);
    });
});
test("wrong catalog digest fails before Windows submission", async (t) => {
  const f = await fixture(t);
  f.input.artifacts[0].provenance.signing.catalogSha256 = "f".repeat(64);
  // The archive must also agree with the reviewed manifest, so checking an
  // attacker who updates both metadata copies reaches the actual catalog check.
  const a = f.input.artifacts[0],
    dir = path.join(f.ws.state, "sources", a.id),
    archive = path.join(f.artifacts_dir, a.archive.path);
  write_json(path.join(dir, "component.json"), a.provenance);
  fs.unlinkSync(archive);
  await create_zip(archive, [
    [path.join(dir, "component.json"), "component.json"],
    ...a.provenance.files.map((r) => [path.join(dir, r.path), r.path]),
  ]);
  a.manifest.sha256 = digest(path.join(dir, "component.json"));
  a.manifest.size = fs.statSync(path.join(dir, "component.json")).size;
  a.archive.sha256 = digest(archive);
  a.archive.size = fs.statSync(archive).size;
  write_json(f.manifest, f.input);
  await assert.rejects(bundles.verify(f.ws, f, identity()), /catalog digest/);
});
test("archive corruption and extra members fail with retained evidence", async (t) => {
  const f = await fixture(t);
  fs.appendFileSync(
    path.join(f.artifacts_dir, f.input.artifacts[0].archive.path),
    "corruption",
  );
  await assert.rejects(bundles.verify(f.ws, f, identity()), /hash\/size/);
});
test("actual PE machine disagrees with an x86 declaration", async (t) => {
  const f = await fixture(t),
    a = f.input.artifacts[2],
    dir = path.join(f.ws.state, "sources", a.id),
    image = a.provenance.files.find((r) => r.architecture);
  write(path.join(dir, image.path), pe("x64"));
  image.sha256 = digest(path.join(dir, image.path));
  const original = readJSON(path.join(dir, "build-manifest.json"));
  original.files.find((f) => f.path === image.path.slice(6)).sha256 =
    image.sha256;
  write_json(path.join(dir, "build-manifest.json"), original);
  a.provenance.originalManifestSha256 = digest(
    path.join(dir, "build-manifest.json"),
  );
  Object.assign(
    a.provenance.files.find((f) => f.path === "build-manifest.json"),
    {
      sha256: a.provenance.originalManifestSha256,
      size: fs.statSync(path.join(dir, "build-manifest.json")).size,
    },
  );
  write_json(path.join(dir, "component.json"), a.provenance);
  const archive = path.join(f.artifacts_dir, a.archive.path);
  fs.unlinkSync(archive);
  await create_zip(archive, [
    [path.join(dir, "component.json"), "component.json"],
    ...a.provenance.files.map((r) => [path.join(dir, r.path), r.path]),
  ]);
  a.manifest.sha256 = digest(path.join(dir, "component.json"));
  a.manifest.size = fs.statSync(path.join(dir, "component.json")).size;
  a.archive.sha256 = digest(archive);
  a.archive.size = fs.statSync(archive).size;
  write_json(f.manifest, f.input);
  await assert.rejects(bundles.verify(f.ws, f, identity()), /actual PE/);
});
test("uncommitted shared install source cannot become a release", async (t) => {
  const f = await fixture(t);
  write(
    path.join(f.ws.root, "packaging/windows/Install-Helios.ps1"),
    "changed",
  );
  assert.throws(() => bundles.validate(f.ws, f.input), /clean/);
});
test("input archives cannot traverse a local symlink", async (t) => {
  const f = await fixture(t),
    a = f.input.artifacts[0],
    original = path.join(f.artifacts_dir, a.archive.path),
    moved = original + ".preserved";
  fs.renameSync(original, moved);
  fs.symlinkSync(moved, original);
  await assert.rejects(bundles.verify(f.ws, f, identity()), /symlink/);
});
test("HLIOSET2 checks footer boundaries and container bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-container-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = path.join(root, "HeliosSetup.exe"),
    payload = Buffer.from([0, 0, 0, 0, 1, 2, 3]),
    footer = Buffer.alloc(64);
  footer.writeBigUInt64LE(128n);
  footer.writeBigUInt64LE(BigInt(payload.length), 8);
  footer.writeBigUInt64LE(4n, 16);
  Buffer.from(hash(payload), "hex").copy(footer, 24);
  footer.write("HLIOSET2", 56);
  write(p, Buffer.concat([pe(), payload, footer]));
  bundles.verify_container(p);
  const bytes = fs.readFileSync(p);
  bytes[128] ^= 1;
  write(p, bytes);
  assert.throws(() => bundles.verify_container(p), /hash/);
  footer.writeBigUInt64LE(100n);
  write(p, Buffer.concat([pe(), payload, footer]));
  assert.throws(() => bundles.verify_container(p), /footer/);
});
test("fresh Nix-packaged MCP exposes all bundle tools with CLI refusal parity", async (t) => {
  const f = await fixture(t),
    root = env.WB_TEST_SOURCE ?? path.resolve(import.meta.dirname, ".."),
    bad = path.join(f.ws.state, "unsupported.json");
  write_json(bad, { schemaVersion: 999 });
  const client = mcp(t, { root, env: { ...env, WB_WORKSPACE_ROOT: root } });
  await client.rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "stage06-test", version: "1" },
  });
  const actual = await client.rpc("tools/call", {
    name: "bundle_verify",
    arguments: {
      manifest: bad,
      artifactsDirectory: f.artifacts_dir,
      background: false,
    },
  });
  const cli = run(
    [
      env.WB_TEST_COMMAND,
      "--workspace",
      root,
      "--json",
      "bundle",
      "verify",
      "--manifest",
      bad,
      "--artifacts-dir",
      f.artifacts_dir,
    ],
    { check: false },
  );
  const direct = JSON.parse(cli.stdout);
  assert.equal(actual.result.isError, true);
  assert.equal(actual.result.structuredContent.exitCode, direct.exitCode);
  assert.equal(actual.result.structuredContent.error, direct.error);
});
test("default bundle jobs deduplicate retries and finish without spawning another job", async (t) => {
  const f = await fixture(t),
    root = env.WB_TEST_SOURCE ?? path.resolve(import.meta.dirname, ".."),
    bad = path.join(f.ws.state, "unsupported.json");
  write_json(bad, { schemaVersion: 999 });
  const common = [
      env.WB_TEST_COMMAND,
      "--workspace",
      root,
      "--state-root",
      f.ws.state,
      "--json",
    ],
    argv = [
      ...common,
      "--request-id",
      "stage06-retry",
      "bundle",
      "fetch",
      "--manifest",
      bad,
      "--artifacts-dir",
      f.artifacts_dir,
    ];
  const first = JSON.parse(run(argv).stdout),
    second = JSON.parse(run(argv).stdout);
  assert.equal(first.result.jobId, second.result.jobId);
  const finished = JSON.parse(
    run(
      [...common, "job", "wait", "--id", first.result.jobId, "--timeout", "3"],
      { check: false },
    ).stdout,
  );
  assert.equal(finished.result.state, "failed");
  assert.equal(finished.result.operation.exitCode, 74);
  assert.match(finished.result.operation.error, /unsupported release/);
});
test("shared CLI/MCP pack assembly preserves equal payloads and symbols with mocked Windows transport", async (t) => {
  const windows = await import("../tools/wb/windows.mjs"),
    f = await fixture(t);
  let submitted = 0,
    request,
    requestPath,
    result,
    exe;
  t.mock.module("../tools/wb/windows.mjs", {
    namedExports: {
      ...windows,
      async submit(
        _ws,
        _name,
        _id,
        _script,
        purpose,
        _args,
        _direct,
        _meta,
        inputs,
      ) {
        assert.equal(purpose, "system");
        submitted++;
        requestPath = inputs["pack-request.json"];
        request = readJSON(requestPath);
        exe = packed_fixture(path.join(path.dirname(requestPath), "payload"));
        result = {
          schemaVersion: 1,
          operationId: request.operationId,
          state: "packed",
          inputSha256: digest(requestPath),
          signatures: {
            catalogMembership: "verified",
            catalogSigner: request.signing.thumbprint,
            certificateSha256: request.signing.certificateSha256,
            catalogSha256: request.signing.catalogSha256,
          },
          file: {
            path:
              "C:\\WinBoatDev\\bundles\\" +
              request.operationId +
              "\\HeliosSetup.exe",
            size: exe.length,
            sha256: hash(exe),
          },
        };
      },
      async wait() {
        return { state: "succeeded", exitCode: 0 };
      },
      download(_ws, _name, remote, local) {
        if (remote.endsWith("pack-result.json")) write_json(local, result);
        else write(local, exe);
      },
    },
  });
  const fresh = await import("../tools/wb/bundles.mjs?mocked-transport"),
    args = { ...f, name: "fresh-fixture" };
  const first = await fresh.assemble(f.ws, args, identity()),
    second = await fresh.assemble(f.ws, args, identity());
  assert.equal(submitted, 2);
  assert.equal(first.payloadDigest, second.payloadDigest);
  const manifest = readJSON(first.manifest);
  assert.equal(manifest.state, "candidate");
  assert.equal(manifest.published, false);
  assert.equal(manifest.installed, false);
  assert.ok(manifest.artifacts.every((a) => a.provenance.symbols.length > 0));
  assert.ok(manifest.payloadFiles.every((f) => !f.path.endsWith(".pdb")));
});

test("hosted handoff validates packed bytes and rejects altered receipts or payloads", async (t) => {
  const f = await fixture(t);
  const preparation_dir = path.join(f.ws.out, "packing-input");
  const operationId = identity();
  const prepared = await bundles.prepare(
    f.ws,
    { ...f, preparation_dir },
    operationId,
  );
  const request = readJSON(path.join(preparation_dir, "pack-request.json"));
  const payload = path.join(f.ws.state, "bundles", operationId, "payload");
  const packed_dir = path.join(f.ws.out, "packed");
  fs.mkdirSync(packed_dir, { recursive: true });
  const exe = packed_fixture(payload);
  const result = {
    schemaVersion: 1,
    operationId,
    state: "packed",
    inputSha256: prepared.requestSha256,
    signatures: {
      catalogMembership: "verified",
      catalogSigner: request.signing.thumbprint,
      certificateSha256: request.signing.certificateSha256,
      catalogSha256: request.signing.catalogSha256,
    },
    file: {
      path: "D:\\a\\runner temp\\HeliosSetup.exe",
      size: exe.length,
      sha256: hash(exe),
    },
  };
  write(path.join(packed_dir, "HeliosSetup.exe"), exe);
  write_json(path.join(packed_dir, "pack-result.json"), result);
  const args = { ...f, preparation_dir, packed_dir };
  const candidate = await bundles.complete(f.ws, args, identity());
  assert.equal(candidate.payloadDigest, prepared.payloadDigest);
  assert.equal(readJSON(candidate.manifest).published, false);
  assert.ok(
    !fs.existsSync(
      path.join(
        f.ws.state,
        "bundles",
        operationId,
        "inputs",
        "qemu-helios",
        "closure.nar",
      ),
    ),
  );
  assert.ok(
    !fs.existsSync(
      path.join(
        f.ws.state,
        "bundles",
        operationId,
        "inputs",
        "helios-guest-x64",
        "files/symbols/runtime.pdb",
      ),
    ),
  );
  write_json(path.join(packed_dir, "pack-result.json"), {
    ...result,
    inputSha256: "0".repeat(64),
  });
  await assert.rejects(
    bundles.complete(f.ws, args, identity()),
    /receipt identity/,
  );
  const changed = path.join(f.ws.out, "changed-payload");
  fs.cpSync(payload, changed, { recursive: true });
  const script = path.join(changed, "Install-Helios.ps1"),
    bytes = fs.readFileSync(script);
  bytes[0] ^= 1;
  fs.writeFileSync(script, bytes);
  const altered = packed_fixture(changed);
  write(path.join(packed_dir, "HeliosSetup.exe"), altered);
  write_json(path.join(packed_dir, "pack-result.json"), {
    ...result,
    file: { ...result.file, size: altered.length, sha256: hash(altered) },
  });
  await assert.rejects(
    bundles.complete(f.ws, args, identity()),
    /packed payload hash/,
  );
  const malicious = {
    ...request,
    branding: { ...request.branding, publisher: "changed" },
  };
  write_json(path.join(preparation_dir, "pack-request.json"), malicious);
  const metadata = readJSON(path.join(preparation_dir, "preparation.json"));
  write_json(path.join(preparation_dir, "preparation.json"), {
    ...metadata,
    requestSha256: digest(path.join(preparation_dir, "pack-request.json")),
  });
  await assert.rejects(
    bundles.complete(f.ws, args, identity()),
    /preparation differs/,
  );
});

test("native closure members are streamed and corrupt retained-only bytes still fail", async (t) => {
  const f = await fixture(t),
    a = f.input.artifacts.find((a) => a.id === "qemu-helios");
  const source = path.join(f.ws.root, ".state/sources", a.id);
  write(
    path.join(source, "closure.nar"),
    Buffer.from("corrupt complete closure"),
  );
  const archive = path.join(f.artifacts_dir, a.archive.path);
  fs.unlinkSync(archive);
  await create_zip(archive, [
    [path.join(source, "component.json"), "component.json"],
    ...a.provenance.files.map((row) => [path.join(source, row.path), row.path]),
  ]);
  a.archive.sha256 = digest(archive);
  a.archive.size = fs.statSync(archive).size;
  write_json(f.manifest, f.input);
  await assert.rejects(
    bundles.verify(f.ws, f, identity()),
    /archive.*(size|content)|size differs/,
  );
});
