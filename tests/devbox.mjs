// Boundary checks with simulated external runtimes, never a live guest.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "../tools/node_modules/fast-xml-parser/src/fxp.js";
import * as common from "../tools/wb/common.mjs";
let context;
const sys = (p) => p.startsWith("/sys/class/drm/");
mock.module("../tools/wb/common.mjs", {
  exports: {
    ...common,
    run: (argv, options) => context.run(argv, options),
    read: (p) => (sys(p) && p.endsWith("/vendor") ? "0x10de" : common.read(p)),
    exists: (p) => (sys(p) && p.endsWith("/driver") ? true : common.exists(p)),
    resolve: (p) =>
      sys(p) && p.endsWith("/driver") ? "/fixture/nvidia" : common.resolve(p),
    list: (p) => (p === "/dev/dri" ? ["/dev/dri/renderD128"] : common.list(p)),
    accessible: (p) =>
      p === "/dev/dri/renderD128" ? true : common.accessible(p),
    walk: (p) =>
      p.startsWith("/nix/store/") && p.endsWith("/share")
        ? [p + "/host-smoke.json"]
        : common.walk(p),
  },
});
const devbox = await import("../tools/wb/devbox.mjs");
const graphics = await import("../tools/wb/graphics.mjs");
const builds = await import("../tools/wb/builds.mjs");
const { Failure, write_json, digest } = common;
const ok = (value = "") => ({
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  returncode: 0,
});
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wb devbox spaces ")),
    root = path.join(base, "different host workspace");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    WB_DOCKER: "fixture-docker",
    WB_PODMAN: "fixture-podman",
    WB_SSH: "fixture-ssh",
    WB_NIX: "fixture-nix",
    WB_SSH_KEYGEN: "fixture-keygen",
    WB_XORRISO: "fixture-xorriso",
    WB_DEVBOX_PAYLOADS: path.join(root, "payloads"),
    WB_NVIDIA_CTK: "fixture-generator",
    WB_NVIDIA_CDI_HOOK: path.join(root, "hook"),
    WB_CONTAINER_HOOKS_DIR: "/nix/store/no-hooks",
  });
  const ws = {
    root,
    state: path.join(root, ".state"),
    config: { devbox: {} },
    resolve: common.resolve,
    journal() {},
  };
  const f = (context = {
    ws,
    root,
    calls: [],
    container: null,
    unavailable: false,
    daemon: "original",
    failImage: false,
  });
  f.write = (relative, data) => {
    const p = path.join(root, relative);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return p;
  };
  f.record = (name = "one") => {
    const record = {
      schemaVersion: 1,
      name,
      identity: "a".repeat(32),
      owner: devbox.owner(ws, true),
      ports: { ssh: 49123, viewer: 49124 },
      image: null,
      runtime: {
        kind: "docker",
        command: ["fixture-docker"],
        daemonId: "original",
      },
      provisioning: { phase: "prepared", verified: false },
      hostArtifact: { manifestSha256: "b".repeat(64) },
    };
    f.save(record);
    return record;
  };
  f.save = (record) => {
    f.current = record;
    write_json(
      path.join(devbox.location(ws, record.name), "devbox.json"),
      record,
    );
  };
  f.inspect = (record, running = false) => ({
    Id: "owned-container",
    Image: record.image?.id || "old-image",
    Config: {
      Labels: {
        "org.winboat.owner": record.owner,
        "org.winboat.identity": record.identity,
      },
    },
    State: { Running: running, ExitCode: 0 },
  });
  f.run = (argv) => {
    f.calls.push(argv);
    if (argv[0] === "fixture-ssh") {
      f.container = f.stopped || f.container;
      return ok();
    }
    if (argv[0] === "fixture-keygen") {
      const key = argv[argv.indexOf("-f") + 1];
      fs.writeFileSync(key, "private key identity");
      fs.writeFileSync(key + ".pub", "ssh-ed25519 public-key identity\n");
      return ok();
    }
    if (argv[0] === "fixture-xorriso") {
      fs.writeFileSync(argv[argv.indexOf("-o") + 1], "answer image");
      return ok();
    }
    if (argv[0] === "fixture-nix") {
      if (argv.includes("path-info")) return ok(f.closure);
      if (f.failImage && argv.includes("--file"))
        return { ...ok(), returncode: 3 };
      const runtime = argv.includes("winboatRuntime"),
        output = runtime
          ? "/nix/store/fixture-runtime"
          : f.write("image-archive", "image archive");
      return ok([{ drvPath: "fixture.drv", outputs: { out: output } }]);
    }
    if (argv.includes("info"))
      return f.unavailable
        ? { ...ok(), returncode: 1 }
        : ok({ ServerVersion: "29", ID: f.daemon });
    if (argv.includes("container") && argv.includes("inspect")) {
      const container = f.containers ? f.containers[argv[0]] : f.container;
      return container
        ? ok([container])
        : { ...ok(), returncode: 1, stderr: "no such container" };
    }
    if (argv.includes("image") && argv.includes("inspect"))
      return ok([
        {
          Id: "new-image",
          Config: {
            Labels: {
              "org.winboat.manifest-sha256": f.newHash,
              "org.winboat.provision-lock-sha256":
                f.current.provisioning.lockSha256,
            },
          },
        },
      ]);
    if (argv.includes("create")) {
      fs.writeFileSync(argv.at(-2), "new disk");
      return ok();
    }
    return ok();
  };
  f.host = (label) => {
    const artifact = path.join(root, label),
      output = "/nix/store/" + "a".repeat(32) + "-" + label;
    f.write(label + "/files/licenses/NOTICE", "license");
    f.write(label + "/files/debug/qemu.debug", "symbols");
    f.closure = {
      [output]: { narHash: "sha256-fixture", narSize: 17, references: [] },
    };
    const manifest = {
      schemaVersion: 1,
      state: "built",
      artifactId: label,
      target: "host-stack",
      abi: "linux-x86_64",
      mode: "release",
      sources: Object.fromEntries(
        ["qemu-helios", "virglrenderer", "venus-protocol"].map((n) => [
          n,
          {
            revision: "d".repeat(40),
            narHash: "sha256-fixture",
            diffSha256: null,
          },
        ]),
      ),
      toolchain: { lockSha256: digest(path.join(root, "devenv.lock")) },
      outputs: [{ outputs: { out: output } }],
      closure: f.closure,
      files: builds._files(path.join(artifact, "files")),
      licenses: ["licenses/NOTICE"],
      symbols: ["debug/qemu.debug"],
    };
    const p = path.join(artifact, "manifest.json");
    write_json(p, manifest);
    return p;
  };
  f.migration = () => {
    f.write("devenv.lock", "Nix lock");
    const old = f.host("old-host"),
      selected = f.host("new-host");
    const record = f.record(),
      directory = devbox.location(ws, "one");
    record.provisioning.verified = true;
    f.write(".state/devboxes/one/answer/provision.lock.json", "{}");
    record.provisioning.lockSha256 = digest(
      path.join(directory, "answer/provision.lock.json"),
    );
    record.image = {
      id: "old-image",
      archiveSha256: "c".repeat(64),
      output: "/nix/store/old-archive",
      runtimeRoot: "/nix/store/old-runtime",
    };
    f.closure = JSON.parse(fs.readFileSync(old)).closure;
    record.hostArtifact = devbox.host_artifact(ws, old);
    f.newClosure = JSON.parse(fs.readFileSync(selected)).closure;
    f.newHash = digest(selected);
    f.save(record);
    const originalRun = f.run;
    f.run = (argv) => {
      if (argv.includes("path-info")) {
        f.calls.push(argv);
        return ok(
          argv.at(-1).endsWith("old-host")
            ? record.hostArtifact && JSON.parse(fs.readFileSync(old)).closure
            : f.newClosure,
        );
      }
      return originalRun(argv);
    };
    for (const [p, bytes] of [
      ["disk.qcow2", "guest disk"],
      ["secrets/ssh", "guest key"],
      ["tpm/tpm2-00.permall", "guest TPM"],
    ])
      f.write(".state/devboxes/one/" + p, bytes);
    return { directory, record, selected };
  };
  return f;
}
const check = (name, fn) => test(name, (t) => fn(fixture(t), t));
check("names symlinks and owner boundaries", (f) => {
  for (const n of ["../external", "", "Upper", "one/two"])
    assert.throws(() => devbox.location(f.ws, n), Failure);
  const outside = path.join(f.root, "external");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.ws.state, "devboxes"), { recursive: true });
  fs.symlinkSync(outside, path.join(f.ws.state, "devboxes/escape"));
  assert.throws(() => devbox.location(f.ws, "escape"), Failure);
  const record = f.record();
  record.owner = "c".repeat(32);
  f.save(record);
  assert.throws(() => devbox.load(f.ws, "one"), Failure);
});
check(
  "unattended guest identities partitioning resources and XML escaping",
  (f) => {
    const config = { diskGiB: 128, cpus: 4, memoryMiB: 8192 };
    assert.deepEqual(devbox.creation_resources(config), [128, 4, 8192]);
    assert.deepEqual(devbox.creation_resources(config, 512), [512, 4, 8192]);
    assert.equal(config.diskGiB, 128);
    assert.deepEqual(devbox.creation_resources({}), [128, 4, 8192]);
    for (const size of [true, 63, 2049, "512"])
      assert.throws(() => devbox.creation_resources(config, size), Failure);
    const xml = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
    }).parse(devbox.answer_xml('example<&"secret', 2, "en-US")).unattend;
    const settings = xml.settings,
      specialize = settings.find((s) => s["@_pass"] === "specialize"),
      oobe = settings.find((s) => s["@_pass"] === "oobeSystem").component;
    assert.equal(specialize.component.ComputerName, "WB-DEVBOX");
    const shell = oobe.find(
        (c) => c["@_name"] === "Microsoft-Windows-Shell-Setup",
      ),
      setup = settings[0].component.find(
        (c) => c["@_name"] === "Microsoft-Windows-Setup",
      );
    assert.equal(shell.UserAccounts.LocalAccounts.LocalAccount.Name, "wbdev");
    assert.equal(
      shell.UserAccounts.LocalAccounts.LocalAccount.Password.Value,
      'example<&"secret',
    );
    assert.equal(setup.ImageInstall.OSImage.InstallFrom.MetaData.Value, "2");
    assert.equal(setup.ImageInstall.OSImage.InstallTo.PartitionID, "3");
    assert.equal(setup.DiskConfiguration.Disk.WillWipeDisk, "true");
    assert.deepEqual(
      setup.DiskConfiguration.Disk.ModifyPartitions.ModifyPartition.map((p) => [
        p.Order,
        p.PartitionID,
      ]),
      [
        ["1", "1"],
        ["2", "3"],
      ],
    );
    assert.equal(oobe[0].UserLocale, "en-US");
  },
);
check("port collisions and reservation", async (f) => {
  const record = f.record(),
    ports = await devbox.allocate_ports(f.ws, devbox.location(f.ws, "two"), {});
  assert.equal(new Set(Object.values(ports)).size, 2);
  for (const p of Object.values(ports))
    assert.ok(!Object.values(record.ports).includes(p));
  await assert.rejects(
    devbox.allocate_ports(f.ws, devbox.location(f.ws, "two"), {
      sshPort: record.ports.ssh,
    }),
    Failure,
  );
});
check("unavailable runtime makes retained loaded observation stale", (f) => {
  f.record();
  f.unavailable = true;
  f.write(
    ".state/devboxes/one/host-observation.json",
    '{"state":"running","loaded":true}',
  );
  const status = devbox.status(f.ws, "one");
  assert.equal(status.state, "runtime-unavailable");
  assert.equal(status.loaded, false);
});
check("foreign container and changed image refused", (f) => {
  const record = f.record();
  f.container = f.inspect(record);
  f.container.Config.Labels["org.winboat.owner"] = "different";
  assert.throws(
    () => devbox.inspect({ command: ["fixture-docker"] }, record),
    Failure,
  );
  f.container.Config.Labels["org.winboat.owner"] = record.owner;
  record.image = { id: "expected-image" };
  assert.throws(
    () => devbox.inspect({ command: ["fixture-docker"] }, record),
    Failure,
  );
});
check(
  "retained runtime survives config change and rejects different daemon",
  (f) => {
    const record = f.record();
    f.ws.config.devbox.containerRuntime = "podman";
    assert.equal(devbox.runtime(f.ws, record).kind, "docker");
    assert.equal(f.calls[0][0], "fixture-docker");
    f.daemon = "other";
    assert.throws(() => devbox.runtime(f.ws, record), Failure);
  },
);
check(
  "legacy runtime discovers owned container and rejects ambiguous stores",
  (f) => {
    const record = f.record();
    delete record.runtime;
    record.image = { id: "old-image" };
    f.containers = { "fixture-podman": f.inspect(record) };
    assert.equal(devbox.runtime(f.ws, record).kind, "podman");
    f.containers = {};
    assert.throws(() => devbox.runtime(f.ws, record), Failure);
    f.containers = {
      "fixture-docker": f.inspect(record, true),
      "fixture-podman": f.inspect(record, true),
    };
    assert.throws(() => devbox.runtime(f.ws, record), Failure);
  },
);
check(
  "destroy confirmation preserves guest disk and refuses a running guest",
  async (f) => {
    const record = f.record(),
      disk = f.write(
        ".state/devboxes/one/disk.qcow2",
        "preserve existing guest",
      );
    await assert.rejects(
      devbox.destroy(f.ws, "one", "wrong", "operation"),
      Failure,
    );
    f.container = f.inspect(record, true);
    await assert.rejects(
      devbox.destroy(f.ws, "one", record.identity, "operation"),
      Failure,
    );
    assert.equal(fs.readFileSync(disk, "utf8"), "preserve existing guest");
  },
);
check(
  "host migration refuses running guests and protocol changes",
  async (f) => {
    const { record, selected } = f.migration();
    f.container = f.inspect(record, true);
    await assert.rejects(
      devbox.migrate_host(f.ws, "one", selected, "running-operation"),
      Failure,
    );
    assert.ok(!f.calls.some((a) => a.includes("--file")));
    f.container = null;
    const changed = JSON.parse(fs.readFileSync(selected));
    changed.sources["venus-protocol"].narHash = "sha256-changed";
    write_json(selected, changed);
    await assert.rejects(
      devbox.migrate_host(f.ws, "one", selected, "protocol-operation"),
      Failure,
    );
    assert.deepEqual(devbox.load(f.ws, "one")[1], record);
    assert.ok(!f.calls.some((a) => a.includes("--file")));
  },
);
check(
  "failed host migration preserves selection disk keys TPM and before receipt",
  async (f) => {
    const { directory, record, selected } = f.migration();
    f.failImage = true;
    await assert.rejects(
      devbox.migrate_host(f.ws, "one", selected, "failed-operation"),
      Failure,
    );
    assert.deepEqual(devbox.load(f.ws, "one")[1], record);
    assert.deepEqual(
      common.readJSON(
        path.join(directory, "host-migrations/failed-operation/before.json"),
      ),
      record,
    );
    for (const [p, value] of [
      ["disk.qcow2", "guest disk"],
      ["secrets/ssh", "guest key"],
      ["tpm/tpm2-00.permall", "guest TPM"],
    ])
      assert.equal(fs.readFileSync(path.join(directory, p), "utf8"), value);
  },
);
check(
  "host migration prepares new image and retains prior identity",
  async (f) => {
    const { directory, record, selected } = f.migration();
    f.container = f.inspect(record);
    const result = await devbox.migrate_host(
        f.ws,
        "one",
        selected,
        "prepared-operation",
      ),
      current = devbox.load(f.ws, "one")[1];
    assert.equal(result.state, "prepared");
    assert.equal(result.loaded, false);
    assert.equal(current.identity, record.identity);
    assert.equal(current.image.id, "new-image");
    assert.deepEqual(
      current.previousHostArtifacts[0].hostArtifact,
      record.hostArtifact,
    );
    assert.deepEqual(current.previousHostArtifacts[0].image, record.image);
    assert.equal(
      fs.readFileSync(path.join(directory, "secrets/ssh"), "utf8"),
      "guest key",
    );
  },
);
check(
  "authenticated shutdown waits for clean completion and preserves timeouts",
  async (f, t) => {
    const record = f.record();
    record.provisioning.verified = true;
    f.save(record);
    const disk = f.write(".state/devboxes/one/disk.qcow2", "keep guest disk");
    f.write("payloads/Shutdown.ps1", "shutdown fixture");
    f.container = f.inspect(record, true);
    f.stopped = f.inspect(record);
    const result = await devbox.down(f.ws, "one", "operation", false, 10);
    assert.equal(result.cleanShutdown, true);
    assert.equal(result.shutdown.method, "ssh");
    f.container = f.inspect(record, true);
    f.stopped = null;
    let clock = 0;
    t.mock.method(performance, "now", () => (clock += 11000));
    await assert.rejects(
      devbox.down(f.ws, "one", "timeout-operation", false, 10),
      /preserved running/,
    );
    assert.ok(!f.calls.some((a) => a.includes("stop")));
    assert.equal(fs.readFileSync(disk, "utf8"), "keep guest disk");
  },
);
check("CDI detects stale files and mismatched GPU before launch", (f) => {
  const driver = f.write("libEGL_nvidia.so.1", "actual installed driver"),
    vendor = f.write("10_nvidia.json", "{}"),
    hook = f.write("hook", "vendor hook");
  const spec = {
    kind: "nvidia.com/gpu",
    devices: [
      {
        name: "GPU-fixture",
        containerEdits: { deviceNodes: [{ path: "/dev/dri/renderD128" }] },
      },
    ],
    containerEdits: {
      mounts: [
        { hostPath: driver, containerPath: "/usr/lib/libEGL_nvidia.so.1" },
        {
          hostPath: vendor,
          containerPath: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json",
        },
      ],
      hooks: [
        {
          path: hook,
          args: ["create-symlinks", "lib.so::/usr/lib/gbm/nvidia-drm_gbm.so"],
        },
      ],
    },
  };
  write_json(path.join(f.root, "cdi/nvidia.json"), spec);
  const rt = { info: { CDISpecDirs: [path.join(f.root, "cdi")] } };
  const initial = graphics.plan({}, "/dev/dri/renderD128", rt);
  assert.equal(initial.cdiDevice, "nvidia.com/gpu=GPU-fixture");
  assert.equal(initial.inputs[0].size, fs.statSync(driver).size);
  assert.throws(() => graphics.plan({}, "/dev/dri/renderD129", rt), Failure);
  fs.unlinkSync(driver);
  assert.throws(
    () => graphics.plan({}, "/dev/dri/renderD128", rt),
    (e) => e instanceof Failure && e.details.missing.includes(driver),
  );
});
check("relocated state preserves ownership and guest defaults", (f) => {
  const record = f.record(),
    moved = path.join(path.dirname(f.root), "relocated workspace with spaces");
  fs.renameSync(f.root, moved);
  f.ws.root = moved;
  f.ws.state = path.join(moved, ".state");
  assert.equal(devbox.load(f.ws, "one")[1].identity, record.identity);
  f.ws.config.devbox.guestUsername = "different-host-user";
  assert.throws(() => devbox.settings(f.ws), Failure);
});
check("private CDI launch ignores system specs and refuses Docker", (f) => {
  assert.throws(
    () =>
      graphics.launch_plan(
        f.ws,
        {},
        "/dev/dri/renderD128",
        { kind: "docker" },
        "operation",
      ),
    Failure,
  );
  const driver = f.write("libEGL_nvidia.so.1", "driver"),
    vendor = f.write("vendor.json", "{}");
  f.write("hook", "hook");
  f.write("generator", "generator");
  process.env.WB_NVIDIA_CTK = path.join(f.root, "generator");
  process.env.WB_NVIDIA_TOOLKIT_ROOT = f.root;
  f.write("devenv.lock", "lock");
  const previous = f.run;
  f.run = (argv) => {
    if (argv[1] === "cdi") {
      write_json(argv.find((a) => a.startsWith("--output=")).slice(9), {
        kind: "nvidia.com/gpu",
        devices: [
          {
            name: "GPU-fixture",
            containerEdits: { deviceNodes: [{ path: "/dev/dri/renderD128" }] },
          },
        ],
        containerEdits: {
          mounts: [
            { hostPath: driver, containerPath: "/usr/lib/libEGL_nvidia.so.1" },
            {
              hostPath: vendor,
              containerPath: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json",
            },
          ],
          hooks: [
            {
              path: process.env.WB_NVIDIA_CDI_HOOK,
              args: ["lib::/usr/lib/gbm/nvidia-drm_gbm.so"],
            },
          ],
        },
      });
      return ok();
    }
    return previous(argv);
  };
  const result = graphics.launch_plan(
    f.ws,
    {},
    "/dev/dri/renderD128",
    { kind: "podman" },
    "operation",
  );
  assert.deepEqual(result.runtimeArguments, [
    "--cdi-spec-dir",
    path.join(f.ws.state, "gpu/operation"),
    "--hooks-dir",
    "/nix/store/no-hooks",
  ]);
  assert.deepEqual(result.runArguments, [
    "--device",
    "nvidia.com/gpu=GPU-fixture",
  ]);
});
check("malformed external CDI is a typed failure", (f) => {
  for (const spec of [
    { devices: [{}] },
    { devices: null },
    {
      containerEdits: {
        mounts: [{ hostPath: "../escape", containerPath: "/lib" }],
      },
    },
  ])
    assert.throws(() => graphics.validate_spec(spec, "bad-spec.yaml"), Failure);
});
check(
  "automatic NVIDIA runtime requires private Podman but legacy discovery probes both",
  (f) => {
    assert.deepEqual(
      devbox
        .runtime_candidates(f.ws, { renderNode: "/dev/dri/renderD128" })
        .map(([k]) => k),
      ["podman"],
    );
    assert.deepEqual(
      devbox
        .runtime_candidates(f.ws, { renderNode: "/dev/dri/renderD128" }, true)
        .map(([k]) => k),
      ["docker", "podman"],
    );
  },
);
check("offline lock rejects path escape and empty locked tools", (f) => {
  const p = path.join(f.root, "config/provision.lock.json"),
    tool = {
      id: "fixture",
      status: "locked",
      install: "install",
      probe: "probe",
      payloads: [
        {
          file: "setup.exe",
          url: "https://example.invalid/setup.exe",
          sha256: "1".repeat(64),
          relativePath: "../external/setup.exe",
        },
      ],
    };
  write_json(p, { schemaVersion: 1, tools: [tool] });
  assert.throws(() => devbox.provision_lock(f.ws), Failure);
  tool.payloads[0].relativePath = "Installers/setup.exe";
  write_json(p, { schemaVersion: 1, tools: [tool] });
  assert.deepEqual(devbox.provision_lock(f.ws).unresolved, []);
  tool.payloads = [];
  write_json(p, { schemaVersion: 1, tools: [tool] });
  assert.throws(() => devbox.provision_lock(f.ws), Failure);
});
check(
  "changed prepared provisioning lock refuses build before external work",
  (f) => {
    const directory = path.join(f.root, "prepared");
    write_json(path.join(directory, "answer/provision.lock.json"), {
      changed: true,
    });
    assert.throws(
      () =>
        devbox.build_image(
          f.ws,
          directory,
          { provisioning: { lockSha256: "2".repeat(64) } },
          {},
        ),
      Failure,
    );
    assert.deepEqual(f.calls, []);
  },
);
check(
  "interrupted creation preserves password SSH identity and existing disk",
  async (f) => {
    // The retry path exits before creating any host firmware or guest disk.
    f.write("devenv.lock", "lock");
    const selected = f.host("host");
    f.closure = common.readJSON(selected).closure;
    const iso = f.write("input.iso", "user supplied ISO"),
      cache = ".state/media/" + digest(iso);
    const xml = f.write(
      cache + "/images.xml",
      '<WIM><IMAGE INDEX="1"><NAME>Enterprise</NAME><WINDOWS><ARCH>9</ARCH><EDITIONID>Enterprise</EDITIONID><LANGUAGES><LANGUAGE>en-US</LANGUAGE></LANGUAGES></WINDOWS></IMAGE></WIM>',
    );
    write_json(path.join(f.root, cache, "metadata.json"), {
      isoSha256: digest(iso),
      xmlSha256: digest(xml),
    });
    f.write("config/provision.lock.json", '{"schemaVersion":1,"tools":[]}');
    const args = {
        name: "one",
        iso,
        manifest: selected,
        locale: "en-US",
        start: false,
      },
      record = f.record();
    record.hostArtifact = devbox.host_artifact(f.ws, selected);
    record.media = await devbox.media(f.ws, iso);
    record.provisioning.lockSha256 = digest(
      path.join(f.root, "config/provision.lock.json"),
    );
    f.save(record);
    const disk = f.write(
        ".state/devboxes/one/disk.qcow2",
        "installed Windows disk",
      ),
      password = f.write(".state/devboxes/one/secrets/password", "keep secret"),
      ssh = f.write(".state/devboxes/one/secrets/ssh", "keep key");
    const result = await devbox.create(f.ws, args, "retry");
    assert.equal(result.state, "prepared");
    assert.equal(result.resumed, true);
    for (const [p, value] of [
      [disk, "installed Windows disk"],
      [password, "keep secret"],
      [ssh, "keep key"],
    ])
      assert.equal(fs.readFileSync(p, "utf8"), value);
    assert.equal(devbox.load(f.ws, "one")[1].identity, record.identity);
    assert.ok(!f.calls.some((a) => a[0] === "fixture-keygen"));
    record.provisioning.phase = "initializing";
    f.save(record);
    f.write(
      ".state/devboxes/one/secrets/ssh.pub",
      "ssh-ed25519 public-key identity\n",
    );
    f.write(
      ".state/devboxes/one/answer/ssh_host_ed25519_key",
      "existing host key",
    );
    f.write(
      ".state/devboxes/one/answer/ssh_host_ed25519_key.pub",
      "ssh-ed25519 pinned-host-key\n",
    );
    f.write(".state/devboxes/one/nvram.fd", "existing firmware");
    fs.mkdirSync(path.join(f.root, "payloads"), { recursive: true });
    await devbox.create(f.ws, args, "initialization-retry");
    for (const [p, value] of [
      [disk, "installed Windows disk"],
      [password, "keep secret"],
      [ssh, "keep key"],
    ])
      assert.equal(fs.readFileSync(p, "utf8"), value);
    assert.equal(devbox.load(f.ws, "one")[1].identity, record.identity);
    assert.ok(!f.calls.some((a) => a[0] === "fixture-keygen"));
  },
);
