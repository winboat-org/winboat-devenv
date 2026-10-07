// Native control plane with simulated SSH/SFTP; live acceptance stays separate.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as common from "../tools/wb/common.mjs";
import * as originalBuilds from "../tools/wb/builds.mjs";
let context;
mock.module("../tools/wb/common.mjs", {
  exports: { ...common, run: (...args) => context.run(...args) },
});
mock.module("../tools/wb/devbox.mjs", {
  exports: {
    load: () => [
      context.guest,
      { identity: context.guestIdentity, ports: { ssh: 49123 } },
    ],
    ssh_command: () => ["fixture-ssh", "-p", "49123", "wbdev@127.0.0.1"],
    name_check: (n) => n,
    location: () => context.guest,
  },
});
mock.module("../tools/wb/builds.mjs", {
  exports: {
    ...originalBuilds,
    plan: () => ({ contract: { toolchain: "linux-msvc-cross" } }),
  },
});
const windows = await import("../tools/wb/windows.mjs");
const { Failure, digest, hash, write_json, readJSON } = common;
test("native kernel addresses retain all hexadecimal bits without a prefix", () => {
  for (const value of [
    "fffff8073ffc0000",
    "0xfffff8073ffc0000",
    "FFFFF8073FFC0000",
  ])
    assert.equal(windows.kernel_base(value), 0xfffff8073ffc0000n);
  for (const value of [
    "invalid",
    "fffffffffffffffff",
    0xfffff8073ffc0000,
    "-1",
  ])
    assert.throws(() => windows.kernel_base(value), Failure);
});
const op = (n) => "op-" + n.repeat(32);
const ok = (v = "") => ({
  stdout: typeof v === "string" ? v : JSON.stringify(v),
  stderr: "",
  returncode: 0,
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb windows spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    WB_SFTP: "fixture-sftp",
    WB_NIX: "fixture-nix",
    WB_DEVBOX_PAYLOADS: path.join(root, "payloads"),
  });
  const f = (context = {
    root,
    guest: path.join(root, "guest"),
    guestIdentity: "a".repeat(32),
    remote: new Map(),
    calls: [],
    starts: 0,
  });
  f.write = (relative, content) => {
    const p = path.join(root, relative);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  f.ws = {
    root,
    state: path.join(root, "state"),
    resolve: common.resolve,
    paths: {},
    repos: {},
    repo_locks: async (_, fn) => fn(),
    journal() {},
  };
  f.write("guest/known_hosts", "pinned key");
  f.write("devenv.lock", "fixture Nix lock");
  f.write("config/provision.lock.json", "fixture provision lock");
  for (const name of [
    "Control.ps1",
    "Task.ps1",
    "LoadedIdentity.cs",
    "Toolchain.ps1",
    "RegistryProjection.ps1",
    "Snapshot.ps1",
    "Graphics.ps1",
    "Install.ps1",
  ])
    f.write("payloads/" + name, name);
  const canonical = (p) => p.replace(/^\//, "").replaceAll("/", "\\");
  f.run = (argv, options = {}) => {
    f.calls.push(argv);
    if (argv[0] === "fixture-ssh") f.lastSshTimeout = options.timeout;
    if (argv[0] === "fixture-nix")
      return argv[1] === "build" ? ok(f.built) : ok("fixture-only");
    if (argv[0] === "fixture-sftp") {
      const batch = options.input,
        quoted = [...batch.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) =>
          m[1].replace(/\\(.)/g, "$1"),
        );
      if (batch.startsWith("put")) {
        const [local, remote] = quoted,
          p = canonical(remote);
        assert.ok(
          !f.remote.has(p),
          "Verified script must not be reopened: " + p,
        );
        const data = fs.readFileSync(local);
        f.remote.set(p, f.corruptUpload ? Buffer.from("corrupt") : data);
        if (f.changeSource) fs.writeFileSync(local, "changed source");
        if (p.endsWith("\\request.json"))
          f.requests = (f.requests || []).concat(JSON.parse(data));
      } else {
        const [remote, local] = quoted;
        fs.writeFileSync(
          local,
          f.corruptDownload
            ? Buffer.from("wrong")
            : f.remote.get(canonical(remote)),
        );
      }
      return ok();
    }
    assert.equal(argv[0], "fixture-ssh");
    const script = Buffer.from(
      argv.at(-1).split("EncodedCommand ").at(-1),
      "base64",
    ).toString("utf16le");
    if (script.includes("@{files=@(foreach"))
      return ok({
        files: [...f.remote]
          .filter(([p]) => p.includes("\\control\\"))
          .map(([p, data]) => ({
            name: path.win32.basename(p),
            sha256: hash(data),
            size: data.length,
          })),
      });
    if (script.includes("$p=") && script.includes("Get-FileHash")) {
      const p = script.match(/\$p='((?:[^']|'')*)'/)[1].replaceAll("''", "'"),
        data = f.remote.get(p);
      return ok(f.remoteReceipt || { sha256: hash(data), size: data.length });
    }
    if (script.includes("-Action ")) {
      if (
        script.includes("-Action 'start'") ||
        script.includes("-Action 'direct'")
      )
        f.starts++;
      const request = f.requests?.at(-1);
      if (request?.metadata.kind === "graphics")
        f.remote.set(
          windows.ROOT +
            "\\jobs\\" +
            request.operationId +
            "\\graphics-result.json",
          Buffer.from('{"state":"passed","sessionId":1}'),
        );
      return ok(
        f.observation || {
          state: "succeeded",
          exitCode: 0,
          operationId: request?.operationId,
          principal: "NT AUTHORITY\\SYSTEM",
          sessionId: 0,
        },
      );
    }
    return ok();
  };
  f.artifact = () => {
    const image = f.write("artifact/files/runtime.dll", "fixture image"),
      p = path.join(root, "artifact/manifest.json");
    write_json(p, {
      schemaVersion: 1,
      state: "built",
      artifactId: op("b"),
      target: "clvk-helios",
      configuration: "release",
      mode: "development",
      sources: {},
      toolchain: {
        lockSha256: digest(path.join(root, "devenv.lock")),
        msvc: {
          lockSha256: digest(path.join(root, "config/provision.lock.json")),
        },
      },
      images: [
        {
          path: "runtime.dll",
          format: "PE",
          architecture: "x64",
          staticCrtVerified: true,
        },
      ],
      files: originalBuilds._files(path.dirname(image)),
      outputs: [{ drvPath: "fixture.drv", outputs: { out: "fixture-output" } }],
    });
    return p;
  };
  return f;
}
const check = (name, fn) => test(name, (t) => fn(fixture(t), t));
check(
  "retained inventory accepts explicit schema views and rejects unknown versions",
  async (f) => {
    const file = path.join(f.guest, "stack-registry.json");
    for (const value of [
      { schemaVersion: 3 },
      { schemaVersion: 2, transactionsView: "unknown" },
    ]) {
      write_json(file, value);
      await assert.rejects(
        windows.registry(f.ws, "one", "show", op("a")),
        (e) => e instanceof Failure && e.code === 76,
      );
    }
    write_json(file, {
      schemaVersion: 2,
      transactionsView: "summary-with-retained-receipts",
      state: "verified",
    });
    assert.equal(
      (await windows.registry(f.ws, "one", "show", op("a"))).observationKind,
      "retained",
    );
  },
);
// Construct raw ZIP records so invalid Windows paths can be tested before the
// producer's own path checks. This is a fixture encoder, not production parsing.
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(f, entries) {
  const bodies = [],
    central = [],
    files = [];
  let offset = 0;
  for (const [name, text, mode = 0o100644] of entries) {
    const data = Buffer.from(text),
      filename = Buffer.from(name),
      compressed = zlib.deflateRawSync(data),
      crc = crc32(data),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE((mode << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    const body = Buffer.concat([header, filename, compressed]);
    bodies.push(body);
    central.push(entry, filename);
    offset += body.length;
    files.push({ path: name, size: data.length, sha256: hash(data) });
  }
  const table = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return [
    f.write("artifact.zip", Buffer.concat([...bodies, table, end])),
    files,
  ];
}
function kernel() {
  const b = Buffer.alloc(1024);
  b.write("MZ");
  b.writeUInt32LE(64, 60);
  b.write("PE\0\0", 64);
  b.writeUInt16LE(0x8664, 68);
  b.writeUInt16LE(2, 70);
  b.writeUInt16LE(240, 84);
  b.writeUInt16LE(0x20b, 88);
  b.writeBigUInt64LE(0x140000000n, 112);
  b.writeUInt32LE(0x4000, 144);
  b.writeUInt32LE(0x3000, 240);
  b.writeUInt32LE(12, 244);
  b.write(".text", 328);
  [16, 0x1000, 16, 512].forEach((v, i) => b.writeUInt32LE(v, 336 + i * 4));
  b.writeUInt32LE(0x60000020, 364);
  b.write(".reloc", 368);
  [12, 0x3000, 12, 768].forEach((v, i) => b.writeUInt32LE(v, 376 + i * 4));
  b.writeUInt32LE(0x42000040, 404);
  b.writeBigUInt64LE(0x140001234n, 512);
  b.write("code1234", 520);
  b.writeUInt32LE(0x1000, 768);
  b.writeUInt32LE(12, 772);
  b.writeUInt16LE(0xa000, 776);
  return b;
}
check("upload refuses corruption and source changes during transfer", (f) => {
  const p = f.write("quotes ' source.ps1", "exit 0");
  f.corruptUpload = true;
  assert.throws(
    () => windows.upload(f.ws, "one", p, "C:\\fixture.ps1"),
    (e) => e instanceof Failure && e.code === 74,
  );
  f.corruptUpload = false;
  f.remote.clear();
  f.changeSource = true;
  assert.throws(
    () => windows.upload(f.ws, "one", p, "C:\\fixture.ps1"),
    Failure,
  );
});
check(
  "download never publishes corrupt bytes or overwrites divergent output",
  (f) => {
    const p = path.join(f.root, "output.dll");
    f.remote.set("C:\\output.dll", Buffer.from("right"));
    f.corruptDownload = true;
    assert.throws(
      () => windows.download(f.ws, "one", "C:\\output.dll", p),
      Failure,
    );
    assert.ok(!fs.existsSync(p));
    assert.equal(
      fs.readdirSync(f.root).filter((n) => n.includes(".partial-")).length,
      1,
    );
    f.write("output.dll", "existing");
    assert.throws(
      () => windows.download(f.ws, "one", "C:\\output.dll", p),
      Failure,
    );
    assert.equal(fs.readFileSync(p, "utf8"), "existing");
  },
);
check(
  "install preflight refuses tampering and Windows aliases before transport",
  async (f) => {
    const image = f.write("fixture.dll", "original"),
      p = path.join(f.root, "manifest.json");
    write_json(p, {
      schemaVersion: 1,
      fixtureId: "acceptance",
      files: [
        {
          path: "fixture.dll",
          sha256: digest(image),
          size: fs.statSync(image).size,
        },
      ],
    });
    fs.writeFileSync(image, "changed!");
    await assert.rejects(
      windows.install(f.ws, "one", p, op("a"), true),
      (e) => e instanceof Failure && e.code === 74,
    );
    assert.equal(f.calls.length, 0);
    for (const name of [
      "../escape",
      "C:/absolute",
      "file:stream",
      "NUL",
      "dir/CON.txt",
      "dir/name.",
      "dir/name ",
      "file\nname",
    ])
      assert.throws(() => windows.windows_relative(name), Failure);
  },
);
check("task IDs and native reboot codes are retained", async (f) => {
  for (const id of ["op-../outside", "bad", op("G")])
    assert.throws(() => windows.job_id(id), Failure);
  write_json(path.join(f.guest, "windows-jobs", op("a"), "job.json"), {
    guestIdentity: f.guestIdentity,
    operationId: op("a"),
    control: "control",
    remote: "remote",
    requestSha256: "hash",
  });
  f.observation = { state: "reboot-required", exitCode: 3010 };
  const observed = await windows.observe_wait(f.ws, "one", op("a"), op("b"), 0);
  assert.equal(observed.terminal, true);
  assert.equal(f.lastSshTimeout, 5000);
  assert.equal(observed.exitCode, 3010);
  f.observation = { state: "running", exitCode: 0 };
  assert.equal(
    (await windows.observe_wait(f.ws, "one", op("a"), op("b"), 0)).timedOut,
    true,
  );
  f.observation = { state: "reboot-required", exitCode: 3010 };
  assert.deepEqual(
    await windows.wait(f.ws, "one", op("a"), true),
    f.observation,
  );
  await assert.rejects(
    windows.wait(f.ws, "one", op("a")),
    (e) => e instanceof Failure && e.code === 3010,
  );
});
check(
  "empty image receipt may recover bundle but never native outputs",
  (f) => {
    const p = f.write("images.json", "");
    assert.deepEqual(
      windows.read_image_inspections(p, "helios-development-package", [
        "bundle/manifest.json",
      ]),
      [],
    );
    assert.equal(fs.readFileSync(p).length, 0);
    for (const target of ["helios-guest-x64", "helios-development-package"])
      assert.throws(
        () => windows.read_image_inspections(p, target, ["package/driver.sys"]),
        (e) => e.code === 74,
      );
  },
);
check(
  "full install requires complete package before guest effects",
  async (f) => {
    const files = [
      "Install-Helios.ps1",
      "Uninstall-Helios.ps1",
      "Verify-Helios.ps1",
      "Helios-PackageCommon.ps1",
    ].map((n) => {
      const p = f.write(n, "exit 0");
      return { path: n, sha256: digest(p), size: fs.statSync(p).size };
    });
    const p = path.join(f.root, "manifest.json");
    write_json(p, {
      schemaVersion: 1,
      architecture: "x64",
      applicationArchitectures: ["x64", "x86"],
      signing: { mode: "test", certificate: "certificate/test.cer" },
      source: { helios: "a".repeat(40) },
      files,
    });
    await assert.rejects(
      windows.install(f.ws, "one", p, op("b")),
      (e) =>
        e.code === 2 &&
        e.details.missing.includes("payload/driver/helios_kmd_render.sys"),
    );
    assert.equal(f.calls.length, 0);
  },
);
check(
  "graphics staging preserves exclusive creation and guest transaction boundary",
  async (f) => {
    const installation = {
        guestIdentity: f.guestIdentity,
        metadata: {
          kind: "install",
          manifestSha256: "c".repeat(64),
          requested: { packageId: "complete-test-package" },
        },
      },
      p = path.join(f.guest, "windows-jobs", op("a"), "job.json");
    write_json(p, installation);
    const args = { action: "smoke", name: "one", transaction: op("a") },
      result = await windows.dispatch(f.ws, args, op("b"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 1);
    const request = f.requests.at(-1);
    assert.equal(request.purpose, "desktop");
    assert.deepEqual(request.arguments, [
      windows.ROOT + "\\jobs\\" + op("b") + "\\graphics.json",
    ]);
    const spec = JSON.parse(
      f.remote.get(windows.ROOT + "\\jobs\\" + op("b") + "\\graphics.json"),
    );
    assert.deepEqual(spec.manifest, installation.metadata.requested);
    assert.equal(spec.transactionId, op("a"));
    installation.guestIdentity = "another";
    write_json(p, installation);
    await assert.rejects(windows.dispatch(f.ws, args, op("d")), Failure);
    await assert.rejects(
      windows.submit(
        f.ws,
        "one",
        op("b"),
        path.join(f.root, "payloads/Graphics.ps1"),
        "desktop",
      ),
      /EEXIST/,
    );
    assert.equal(f.starts, 1);
  },
);
check(
  "tool mirror reuse requires same guest exact files and successful job",
  async (f) => {
    const tool = f.write("fixture-tool/tool.exe", "fixture executable");
    f.built = [
      { drvPath: "fixture.drv", outputs: { out: path.dirname(tool) } },
    ];
    const first = await windows.mirror_build_tools(f.ws, "one", "utilities"),
      reused = await windows.mirror_build_tools(f.ws, "one", "utilities");
    assert.equal(reused.operationId, first.operationId);
    assert.equal(reused.reusedVerifiedMirror, true);
    assert.equal(f.starts, 1);
    f.guestIdentity = "b".repeat(32);
    const another = await windows.mirror_build_tools(f.ws, "one", "utilities");
    assert.notEqual(another.operationId, first.operationId);
    assert.equal(f.starts, 2);
    fs.writeFileSync(tool, "changed fixture executable");
    const changed = await windows.mirror_build_tools(f.ws, "one", "utilities");
    assert.notEqual(changed.operationId, another.operationId);
    assert.equal(f.starts, 3);
  },
);
check(
  "cross artifact import verifies locks bytes architecture and guest identity",
  async (f) => {
    const p = f.artifact(),
      first = await windows.import_artifact(
        f.ws,
        "one",
        p,
        "release",
        "development",
      );
    assert.equal(first.guestIdentity, f.guestIdentity);
    const reused = await windows.import_artifact(
      f.ws,
      "one",
      p,
      "release",
      "development",
    );
    assert.equal(reused.reusedVerifiedMirror, true);
    assert.equal(f.starts, 1);
    const request = f.requests[0],
      spec = JSON.parse(
        f.remote.get(
          windows.ROOT + "\\jobs\\" + request.operationId + "\\snapshot.json",
        ),
      );
    assert.equal(spec.destinationKind, "artifact");
    assert.deepEqual(spec.images, [
      { path: "runtime.dll", architecture: "x64" },
    ]);
    const importedZip = f.write(
      "imported.zip",
      f.remote.get(
        windows.ROOT + "\\jobs\\" + request.operationId + "\\artifact.zip",
      ),
    );
    await windows.extract_artifact(
      importedZip,
      path.join(f.root, "imported-files"),
      readJSON(p).files,
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, "imported-files/runtime.dll"), "utf8"),
      "fixture image",
    );
    f.guestIdentity = "b".repeat(32);
    const another = await windows.import_artifact(
      f.ws,
      "one",
      p,
      "release",
      "development",
    );
    assert.notEqual(another.operationId, first.operationId);
    assert.equal(f.starts, 2);
    f.write("config/provision.lock.json", "changed lock");
    await assert.rejects(
      windows.import_artifact(f.ws, "one", p, "release", "development"),
      Failure,
    );
    f.write("artifact/files/runtime.dll", "changed image");
    await assert.rejects(
      windows.import_artifact(f.ws, "one", p, "release", "development"),
      Failure,
    );
    assert.equal(f.starts, 2);
  },
);
check(
  "resident kernel proof normalizes full 64-bit relocation and detects replaced SYS",
  async (f) => {
    const original = kernel(),
      mapped = Buffer.from(original.subarray(512, 528)),
      base = 0xfffff80100000000n;
    mapped.writeBigUInt64LE(base + 0x1234n);
    const read = (rva, size) =>
      rva === 0 ? original.subarray(0, size) : mapped;
    assert.equal(
      (await windows.mapped_kernel_identity(original, base, read)).state,
      "mapped-code-matches",
    );
    const changed = Buffer.from(original);
    changed[525] ^= 1;
    assert.equal(
      (await windows.mapped_kernel_identity(changed, base, read)).state,
      "stale-mapped-image",
    );
    await assert.rejects(
      windows.mapped_kernel_identity(original, base, () => Buffer.alloc(0)),
      Failure,
    );
  },
);
check(
  "resident proof refuses unsupported executable relocations",
  async (f) => {
    const image = kernel();
    image.writeUInt16LE(0x3000, 776);
    await assert.rejects(
      windows.mapped_kernel_identity(image, 0xfffff80100000000n, (rva, size) =>
        rva === 0 ? image.subarray(0, size) : image.subarray(512, 528),
      ),
      Failure,
    );
  },
);
check(
  "archive complete file table and resume preserve existing output",
  async (f) => {
    const [archive, files] = zip(f, [
        ["package/test.dll", "image"],
        ["licenses/NOTICE", "notice"],
      ]),
      destination = path.join(f.root, "export/files"),
      image = path.join(destination, "package/test.dll");
    await windows.extract_artifact(archive, destination, files);
    const stamp = fs.statSync(image, { bigint: true }).mtimeNs;
    await windows.extract_artifact(archive, destination, files);
    assert.equal(fs.statSync(image, { bigint: true }).mtimeNs, stamp);
    fs.writeFileSync(image, "manual drift");
    await assert.rejects(
      windows.extract_artifact(archive, destination, files),
      Failure,
    );
    assert.equal(fs.readFileSync(image, "utf8"), "manual drift");
  },
);
check("Windows archive separators match canonical table", async (f) => {
  const [archive, files] = zip(f, [["package\\test.dll", "image"]]);
  files[0].path = "package/test.dll";
  const destination = path.join(f.root, "files");
  await windows.extract_artifact(archive, destination, files);
  assert.equal(
    fs.readFileSync(path.join(destination, "package/test.dll"), "utf8"),
    "image",
  );
});
check(
  "empty ZIP directories are metadata and cannot hide data or aliases",
  async (f) => {
    const entries = [["package\\test.dll", "image"]],
      [archive, files] = zip(f, [
        ...entries,
        ["licenses\\venus-protocol\\", ""],
      ]);
    files.splice(1);
    files[0].path = "package/test.dll";
    await windows.extract_artifact(
      archive,
      path.join(f.root, "valid/files"),
      files,
    );
    assert.ok(!fs.existsSync(path.join(f.root, "valid/files/licenses")));
    for (const [name, data, mode] of [
      ["../escape\\", ""],
      ["C:\\escape\\", ""],
      ["licenses\\notice\\", "hidden data"],
      ["package\\test.dll\\", ""],
      ["licenses\\link\\", "", 0o120777],
    ]) {
      const [p] = zip(f, [...entries, [name, data, mode]]),
        destination = path.join(f.root, "refused/files");
      await assert.rejects(
        windows.extract_artifact(p, destination, files),
        Failure,
      );
      assert.ok(!fs.existsSync(destination));
    }
  },
);
check("source links materialize without cycles or escape", (f) => {
  const source = path.join(f.root, "source");
  f.write("source/bin/tool.py", "build source");
  fs.mkdirSync(path.join(source, "ci"));
  fs.symlinkSync("../bin", path.join(source, "ci/bin"));
  const [files, links] = windows.windows_source_files(source);
  assert.deepEqual(
    new Set(files.map(([p]) => p)),
    new Set(["bin/tool.py", "ci/bin/tool.py"]),
  );
  assert.deepEqual(links, [
    { path: "ci/bin", target: "../bin", materialized: "directory" },
  ]);
  const materialized = path.join(f.root, "materialized");
  assert.deepEqual(windows.materialize_source(source, materialized), links);
  assert.equal(
    fs.readFileSync(path.join(materialized, "ci/bin/tool.py"), "utf8"),
    "build source",
  );
  assert.ok(!fs.lstatSync(path.join(materialized, "ci/bin")).isSymbolicLink());
  fs.symlinkSync("..", path.join(source, "bin/cycle"));
  assert.throws(() => windows.windows_source_files(source), Failure);
  fs.unlinkSync(path.join(source, "bin/cycle"));
  fs.symlinkSync(f.root, path.join(source, "outside"));
  assert.throws(() => windows.windows_source_files(source), Failure);
});
check(
  "release dependency rejects stale pins dirty tracked files and untracked files",
  async (f) => {
    const repository = path.join(f.root, "repository");
    fs.mkdirSync(repository);
    const git = (...args) => common.git(repository, ...args).stdout;
    git("init", "-q");
    f.write("repository/source.txt", "source");
    git("add", "source.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const revision = git("rev-parse", "HEAD").trim(),
      ws = {
        paths: { fixture: repository },
        repos: { fixture: { pin: { rev: revision } } },
        repo_locks: async (_, fn) => fn(),
      },
      manifest = { sources: { fixture: { revision } } };
    await windows.validate_dependency_sources(ws, manifest, "release");
    f.write("repository/source.txt", "changed");
    await assert.rejects(
      windows.validate_dependency_sources(ws, manifest, "release"),
      Failure,
    );
    await windows.validate_dependency_sources(ws, manifest, "development");
    git("checkout", "--", "source.txt");
    f.write("repository/untracked.txt", "new");
    await assert.rejects(
      windows.validate_dependency_sources(ws, manifest, "release"),
      Failure,
    );
    fs.unlinkSync(path.join(repository, "untracked.txt"));
    ws.repos.fixture.pin.rev = "0".repeat(40);
    await assert.rejects(
      windows.validate_dependency_sources(ws, manifest, "release"),
      Failure,
    );
  },
);
check(
  "concurrent control publication never reopens verified scripts",
  async (f) => {
    const results = await Promise.all([
      windows.payloads(f.ws, "one"),
      windows.payloads(f.ws, "one"),
    ]);
    assert.equal(results[0], results[1]);
    assert.equal(f.calls.filter((a) => a[0] === "fixture-sftp").length, 5);
    const key = [...f.remote.keys()].find((p) => p.endsWith("Toolchain.ps1"));
    f.remote.set(key, Buffer.from("tampered"));
    await assert.rejects(windows.payloads(f.ws, "one"), Failure);
    assert.equal(f.calls.filter((a) => a[0] === "fixture-sftp").length, 5);
  },
);
check("archive table errors fail before publishing", async (f) => {
  for (const [entries, table] of [
    [[["../escape", "x"]], [{ path: "safe", size: 1, sha256: "0".repeat(64) }]],
    [
      [
        ["safe", "x"],
        ["unexpected", "x"],
      ],
      [{ path: "safe", size: 1, sha256: "0".repeat(64) }],
    ],
    [[["safe", "x"]], [{ path: "missing", size: 1, sha256: "0".repeat(64) }]],
    [
      [
        ["safe", "x"],
        ["SAFE", "x"],
      ],
      [{ path: "safe", size: 1, sha256: "0".repeat(64) }],
    ],
    [[["safe", "x"]], [{ path: "safe", size: 2, sha256: "0".repeat(64) }]],
  ]) {
    const [archive] = zip(f, entries),
      destination = path.join(f.root, "files");
    await assert.rejects(
      windows.extract_artifact(archive, destination, table),
      Failure,
    );
    assert.ok(!fs.existsSync(destination));
  }
});
check(
  "archive corruption keeps partial bytes outside published artifact",
  async (f) => {
    const [archive, files] = zip(f, [["package/test.dll", "wrong"]]);
    files[0].sha256 = "0".repeat(64);
    const destination = path.join(f.root, "export/files");
    await assert.rejects(
      windows.extract_artifact(archive, destination, files),
      Failure,
    );
    assert.ok(!fs.existsSync(path.join(destination, "package/test.dll")));
    assert.equal(
      fs
        .readdirSync(path.dirname(destination))
        .filter((n) => n.startsWith("artifact.partial-")).length,
      1,
    );
  },
);
check("archive and destination symlinks refused", async (f) => {
  const [archive, files] = zip(f, [["package/test.dll", "image"]]),
    destination = path.join(f.root, "export/files"),
    outside = path.join(f.root, "external");
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(destination, "package"));
  await assert.rejects(
    windows.extract_artifact(archive, destination, files),
    Failure,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  const [link] = zip(f, [["package/test.dll", "image", 0o120777]]);
  await assert.rejects(
    windows.extract_artifact(link, path.join(f.root, "symlink-export"), files),
    Failure,
  );
});
