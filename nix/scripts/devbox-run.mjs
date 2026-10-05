// Nix-owned container entry point. Persistent state belongs to one devbox.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
const state = "/state",
  env = process.env,
  owner = fs.statSync(state),
  settings = JSON.parse(fs.readFileSync(path.join(state, "launch.json"))),
  stack = env.WB_STACK,
  children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => {
  const h = crypto.createHash("sha256"),
    fd = fs.openSync(p, "r"),
    b = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, b, 0, b.length, null)))
      h.update(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
};
const save = (data) => {
  const p = path.join(state, "host-observation.json"),
    tmp = path.join(state, "host-observation.tmp");
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, p);
};
function ownership() {
  if (process.geteuid() !== 0 || owner.uid === 0) return;
  const paths = [
    "qmp.sock",
    "tpm.sock",
    "host-observation.json",
    "host-observation.tmp",
    "qemu.log",
    "serial.log",
  ].map((n) => path.join(state, n));
  const walk = (p) => {
    for (const n of fs.readdirSync(p)) {
      const child = path.join(p, n);
      paths.push(child);
      const s = fs.lstatSync(child);
      if (s.isDirectory() && !s.isSymbolicLink()) walk(child);
    }
  };
  for (const name of ["samba", "tpm"]) {
    const directory = path.join(state, name);
    if (!fs.existsSync(directory)) continue;
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error("Private service state cannot be a symlink");
    paths.push(directory);
    walk(directory);
  }
  for (const p of paths)
    try {
      fs.lchownSync(p, owner.uid, owner.gid);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
}
function child(argv, options = {}) {
  const c = spawn(argv[0], argv.slice(1), options);
  c.done = new Promise((resolve) =>
    c.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1))),
  );
  c.on("error", (error) => {
    c.startError = error;
  });
  children.push(c);
  return c;
}
function stop() {
  for (const c of [...children].reverse())
    if (c.exitCode === null) c.kill("SIGTERM");
}
async function cleanup() {
  stop();
  for (const c of children) {
    let timedOut = false;
    let timer;
    await Promise.race([
      c.done,
      new Promise((r) => {
        timer = setTimeout(() => {
          timedOut = true;
          r();
        }, 10000);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      c.kill("SIGKILL");
      await c.done;
    }
  }
  ownership();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
async function qmp(requests) {
  const client = net.createConnection(path.join(state, "qmp.sock")),
    lines = readline.createInterface({ input: client }),
    iterator = lines[Symbol.asyncIterator]();
  const failed = new Promise((_, reject) => {
    client.on("error", reject);
    client.on("close", () => reject(new Error("QMP disconnected")));
  });
  failed.catch(() => {});
  const timer = setTimeout(
    () => client.destroy(new Error("QMP timeout")),
    15000,
  );
  const next = async () => {
    const r = await Promise.race([iterator.next(), failed]);
    if (r.done) throw new Error("QMP disconnected");
    return JSON.parse(r.value);
  };
  try {
    await next();
    const responses = [];
    for (const [i, request] of [
      { execute: "qmp_capabilities" },
      ...requests,
    ].entries()) {
      client.write(JSON.stringify({ ...request, id: i }) + "\n");
      let found = false;
      for (let n = 0; n < 100; n++) {
        const reply = await next();
        if (reply.id !== i) continue;
        if (reply.error)
          throw new Error("QMP request failed: " + JSON.stringify(reply));
        responses.push(reply.return);
        found = true;
        break;
      }
      if (!found) throw new Error("QMP event bound exceeded");
    }
    return responses.slice(1);
  } finally {
    clearTimeout(timer);
    lines.close();
    client.destroy();
  }
}
const files = (p) =>
  fs
    .readdirSync(p)
    .sort()
    .filter((n) => n.endsWith(".json"))
    .map((n) => path.join(p, n));
let identity = {
  schemaVersion: 1,
  state: "starting",
  hostStack: stack,
  loaded: false,
};
try {
  ownership();
  for (const name of [
    "tpm",
    "samba",
    "samba/private",
    "samba/lock",
    "samba/cache",
    "samba/ncalrpc",
  ])
    fs.mkdirSync(path.join(state, name), { recursive: true });
  const payloads = env.WB_WINDOWS_PAYLOADS;
  if (
    sha(path.join(payloads, "provision.lock.json")) !==
    settings.provisionLockSha256
  )
    throw new Error(
      "Container provisioning payload lock differs from the prepared guest",
    );
  const config = path.join(state, "samba/smb.conf");
  fs.writeFileSync(
    config,
    `[global]
  server role = standalone server
  security = user
  workgroup = WORKGROUP
  map to guest = Never
  smb ports = 445
  server min protocol = SMB2
  private dir = /state/samba/private
  lock directory = /state/samba/lock
  state directory = /state/samba
  cache directory = /state/samba/cache
  pid directory = /state/samba
  ncalrpc dir = /state/samba/ncalrpc
  log file = /state/samba/log.%m
  load printers = no
  disable spoolss = yes
  printing = bsd
[workspace]
  path = /workspace
  read only = yes
  valid users = wbdev
  follow symlinks = no
  wide links = no
  veto files = /.state/.git/.devenv*/.direnv/.codex/.agents/.aws/.claude/out/build/node_modules/local*.json/.env*/*.key/*.pfx/*.p12/*.iso/*.qcow2/*.vhd*/
  delete veto files = no
[tools]
  path = ${payloads}
  read only = yes
  valid users = wbdev
  follow symlinks = no
  wide links = no
`,
  );
  const password = fs
      .readFileSync(path.join(state, "secrets/password"), "utf8")
      .trim(),
    pass = spawnSync(env.WB_SMBPASSWD, ["-s", "-a", "wbdev", "-c", config], {
      input: password + "\n" + password + "\n",
      stdio: ["pipe", "inherit", "inherit"],
    });
  if (pass.error || pass.status)
    throw new Error("Samba account initialization failed");
  const samba = child(
    [
      env.WB_SMBD,
      "--foreground",
      "--no-process-group",
      "--configfile=" + config,
    ],
    { stdio: "inherit" },
  );
  let listening = false;
  for (let i = 0; i < 100; i++) {
    if (samba.exitCode !== null || samba.startError)
      throw new Error(
        "Authenticated SMB service exited before guest launch; inspect samba/log.smbd",
      );
    listening = await new Promise((r) => {
      const s = net.createConnection({ host: "127.0.0.1", port: 445 });
      s.setTimeout(200);
      s.once("connect", () => {
        s.destroy();
        r(true);
      });
      s.once("error", () => {
        s.destroy();
        r(false);
      });
      s.once("timeout", () => {
        s.destroy();
        r(false);
      });
    });
    if (listening) break;
    await sleep(100);
  }
  if (!listening)
    throw new Error(
      "Authenticated SMB service did not listen before guest launch",
    );
  const tpmSocket = path.join(state, "tpm.sock");
  fs.rmSync(tpmSocket, { force: true });
  child(
    [
      env.WB_SWTPM,
      "socket",
      "--tpm2",
      "--tpmstate",
      "dir=/state/tpm",
      "--ctrl",
      "type=unixio,path=/state/tpm.sock",
      "--flags",
      "not-need-init",
    ],
    { stdio: "inherit" },
  );
  for (let i = 0; i < 100 && !fs.existsSync(tpmSocket); i++) await sleep(50);
  if (!fs.existsSync(tpmSocket)) throw new Error("TPM emulator did not start");
  const qmpSocket = path.join(state, "qmp.sock");
  fs.rmSync(qmpSocket, { force: true });
  const firmware = path.join(stack, "share/qemu");
  if (!fs.existsSync(path.join(state, "nvram.fd")))
    throw new Error("NVRAM must be initialized by wb devbox create");
  const command = [
    path.join(stack, "bin/qemu-system-x86_64"),
    "-name",
    "WB-DEVBOX",
    "-machine",
    "q35,accel=kvm,smm=on,memory-backend=wb-ram",
    "-cpu",
    "host",
    "-smp",
    String(settings.cpus),
    "-m",
    String(settings.memoryMiB),
    "-object",
    "memory-backend-memfd,id=wb-ram,share=on,size=" + settings.memoryMiB + "M",
    "-L",
    firmware,
    "-nodefaults",
    "-no-user-config",
    "-drive",
    "if=pflash,format=raw,readonly=on,file=" +
      path.join(firmware, "edk2-x86_64-secure-code.fd"),
    "-drive",
    "if=pflash,format=raw,file=/state/nvram.fd",
    "-drive",
    "if=none,id=os,format=qcow2,file=/state/disk.qcow2",
    "-device",
    "ich9-ahci,id=ahci",
    "-device",
    "ide-hd,drive=os,bus=ahci.0",
    "-chardev",
    "socket,id=tpm,path=/state/tpm.sock",
    "-tpmdev",
    "emulator,id=tpm,chardev=tpm",
    "-device",
    "tpm-tis,tpmdev=tpm",
    "-device",
    "virtio-vga-gl,id=wb-gpu,blob=on,venus=on,hostmem=8G,max_hostmem=8G",
    "-display",
    "egl-headless,rendernode=" + settings.renderNode,
    "-vnc",
    "0.0.0.0:0",
    "-qmp",
    "unix:/state/qmp.sock,server=on,wait=off",
    "-device",
    "qemu-xhci",
    "-device",
    "usb-tablet",
    "-netdev",
    "user,id=net,hostfwd=tcp::22-:22",
    "-device",
    "e1000e,netdev=net",
    "-serial",
    "file:/state/serial.log",
    "-monitor",
    "none",
    "-boot",
    "order=c,menu=off" + (settings.initialBoot ? ",once=d" : ""),
  ];
  if (settings.attachMedia)
    command.push(
      "-drive",
      "if=none,id=iso,media=cdrom,readonly=on,file=/media/windows.iso",
      "-device",
      "ide-cd,drive=iso,bus=ahci.1",
      "-drive",
      "if=none,id=answer,media=cdrom,readonly=on,file=/state/answer.iso",
      "-device",
      "ide-cd,drive=answer,bus=ahci.2",
    );
  const environment = { ...env, QEMU_MODULE_DIR: path.join(stack, "lib/qemu") },
    graphics = settings.graphics ?? { provider: "mesa" };
  if (graphics.provider === "nvidia-cdi") {
    for (const item of graphics.inputs)
      if (sha(item.containerPath) !== item.sha256)
        throw new Error(
          "Injected NVIDIA CDI file differs from verified host input: " +
            item.containerPath,
        );
    environment.LD_LIBRARY_PATH = [
      ...graphics.libraryDirectories,
      env.WB_GRAPHICS_LIBRARIES,
    ].join(":");
    environment.GBM_BACKENDS_PATH = graphics.gbmBackendDirectories.join(":");
    environment.GBM_BACKEND = "nvidia-drm";
    environment.__EGL_VENDOR_LIBRARY_FILENAMES =
      graphics.eglVendorFiles.join(":");
    environment.VK_DRIVER_FILES = graphics.vulkanIcdFiles.join(":");
  } else {
    environment.LIBGL_DRIVERS_PATH ??= env.WB_MESA + "/lib/dri";
    environment.GBM_BACKENDS_PATH ??= env.WB_MESA + "/lib/gbm";
    environment.__EGL_VENDOR_LIBRARY_FILENAMES ??= files(
      env.WB_MESA + "/share/glvnd/egl_vendor.d",
    ).join(":");
    environment.VK_DRIVER_FILES ??= files(
      env.WB_MESA + "/share/vulkan/icd.d",
    ).join(":");
  }
  const probe = spawnSync(env.WB_VULKAN_PROBE, [], {
    env: environment,
    encoding: "utf8",
    timeout: 30000,
  });
  if (probe.error || probe.status)
    throw new Error(
      "Host Vulkan preflight failed: " +
        (probe.stderr?.trim() || probe.error?.message),
    );
  const log = fs.openSync(path.join(state, "qemu.log"), "a"),
    vm = child(command, { env: environment, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  Object.assign(identity, {
    pid: vm.pid,
    command,
    hostVulkan: JSON.parse(probe.stdout),
  });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (vm.exitCode !== null || vm.startError)
      throw new Error("QEMU exited: inspect qemu.log");
    if (fs.existsSync(qmpSocket)) {
      if (process.geteuid() === 0) {
        fs.chownSync(qmpSocket, owner.uid, owner.gid);
        fs.chmodSync(qmpSocket, 0o600);
      }
      const properties = [
          ["/machine/peripheral/wb-gpu", "blob", true],
          ["/machine/peripheral/wb-gpu", "venus", true],
          ["/machine/peripheral/wb-gpu", "hostmem", 8 * 1024 ** 3],
          ["/objects/wb-ram", "share", true],
        ],
        responses = await qmp([
          { execute: "query-status" },
          ...properties.map(([p, property]) => ({
            execute: "qom-get",
            arguments: { path: p, property },
          })),
        ]);
      identity.qmp = responses[0];
      identity.guestGraphics = {};
      for (const [i, [, property, expected]] of properties.entries()) {
        if (responses[i + 1] !== expected)
          throw new Error("Helios graphics property differs: " + property);
        identity.guestGraphics[property] = responses[i + 1];
      }
      if (settings.initialBoot)
        for (let n = 0; n < 12; n++) {
          await qmp([
            {
              execute: "send-key",
              arguments: { keys: [{ type: "qcode", data: "spc" }] },
            },
          ]);
          await sleep(500);
        }
      ready = true;
      break;
    }
    await sleep(100);
  }
  if (!ready) throw new Error("QMP did not become ready");
  const mapped = () =>
      [
        ...new Set(
          fs
            .readFileSync(`/proc/${vm.pid}/maps`, "utf8")
            .split("\n")
            .map((l) => l.trim().split(/\s+/))
            .filter((c) => c.length >= 6 && c.at(-1).startsWith("/"))
            .map((c) => c.at(-1)),
        ),
      ].sort(),
    selected = mapped().filter(
      (p) =>
        p.startsWith("/nix/store/") &&
        (p.includes("libvirglrenderer") || p.includes("/lib/qemu/")),
    );
  if (!selected.some((p) => p.includes("libvirglrenderer")))
    throw new Error("QEMU has not loaded the selected renderer");
  if (!selected.some((p) => p.includes("virtio-vga-gl")))
    throw new Error("QEMU has not loaded its virtio-vga-gl module");
  const exe = `/proc/${vm.pid}/exe`,
    images = [
      { path: fs.readlinkSync(exe), sha256: sha(exe) },
      ...selected.map((p) => ({ path: p, sha256: sha(p) })),
    ];
  if (images.some((i) => settings.expectedImages[i.path] !== i.sha256))
    throw new Error(
      "Loaded executable/renderer/modules differ from the artifact manifest",
    );
  const observedGraphics = {
    provider: graphics.provider,
    renderNode: settings.renderNode,
  };
  if (graphics.provider === "nvidia-cdi") {
    const driverImages = mapped()
        .filter(
          (p) => path.basename(p).includes("nvidia") && fs.statSync(p).isFile(),
        )
        .map((p) => ({ path: p, sha256: sha(p) })),
      expected = Object.fromEntries(
        graphics.inputs.map((i) => [
          fs.realpathSync(i.containerPath),
          i.sha256,
        ]),
      );
    if (!driverImages.some((i) => i.path.includes("libEGL_nvidia")))
      throw new Error("QEMU has not loaded NVIDIA EGL");
    if (
      driverImages.some((i) => expected[fs.realpathSync(i.path)] !== i.sha256)
    )
      throw new Error("Loaded NVIDIA images differ from verified CDI inputs");
    Object.assign(observedGraphics, {
      cdiDevice: graphics.cdiDevice,
      specSha256: graphics.spec.sha256,
      driverImages,
      driverInputsMatch: true,
    });
  }
  Object.assign(identity, {
    graphics: observedGraphics,
    state: "running",
    loaded: true,
    images,
  });
  save(identity);
  const code = await vm.done;
  Object.assign(identity, { state: "stopped", exitCode: code, loaded: false });
  process.exitCode = code;
} catch (error) {
  Object.assign(identity, {
    state: "failed",
    error: error.message,
    loaded: false,
  });
  process.exitCode = 1;
} finally {
  save(identity);
  await cleanup();
}
