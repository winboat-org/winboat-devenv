import YAML from "yaml";
import {
  fs,
  path,
  env,
  Failure,
  digest,
  run,
  write_json,
  read,
  list,
  resolve,
  file,
  exists,
  accessible,
  mkdir,
} from "./common.mjs";
export function node_identity(p) {
  const device = path.join("/sys/class/drm", path.basename(p), "device");
  let vendor = null;
  try {
    vendor = read(path.join(device, "vendor")).trim();
  } catch {}
  return {
    vendor,
    driver: exists(path.join(device, "driver"))
      ? path.basename(resolve(path.join(device, "driver")))
      : null,
  };
}
export function provider(config, node) {
  const hardware = node_identity(node);
  let selected = config.graphicsProvider ?? "auto";
  if (!["auto", "mesa", "nvidia-cdi"].includes(selected))
    throw new Failure("graphicsProvider must be auto, mesa or nvidia-cdi", 2);
  if (selected === "auto")
    selected = hardware.driver === "nvidia" ? "nvidia-cdi" : "mesa";
  if (selected === "mesa" && hardware.driver === "nvidia")
    throw new Failure(
      "the proprietary NVIDIA node requires graphicsProvider nvidia-cdi",
      3,
    );
  if (selected === "nvidia-cdi" && hardware.driver !== "nvidia")
    throw new Failure(
      "nvidia-cdi requires a render node bound to the NVIDIA driver",
      2,
    );
  return { provider: selected, renderNode: node, ...hardware };
}
export function validate_spec(spec, p) {
  const require = (v) => {
    if (!v)
      throw new Failure("invalid generated CDI structure", 3, { path: p });
  };
  require(spec && typeof spec === "object");
  require(Array.isArray(spec.devices === undefined ? [] : spec.devices));
  const edits = [spec.containerEdits ?? {}];
  for (const d of spec.devices ?? []) {
    require(d && typeof d === "object" && typeof d.name === "string");
    edits.push(d.containerEdits ?? {});
  }
  for (const edit of edits) {
    require(edit && typeof edit === "object" && !Array.isArray(edit));
    for (const key of ["mounts", "deviceNodes", "hooks"]) {
      require(Array.isArray(edit[key] ?? []));
      for (const entry of edit[key] ?? []) {
        require(entry && typeof entry === "object");
        for (const f of key === "mounts"
          ? ["hostPath", "containerPath"]
          : ["path"])
          require(
            typeof entry[f] === "string" &&
              entry[f].startsWith("/") &&
              !entry[f].includes("\0"),
          );
        if (key === "deviceNodes" && Object.hasOwn(entry, "hostPath"))
          require(
            typeof entry.hostPath === "string" &&
              entry.hostPath.startsWith("/"),
          );
        if (key === "hooks")
          require(
            Array.isArray(entry.args ?? []) &&
              (entry.args ?? []).every((v) => typeof v === "string"),
          );
      }
    }
  }
}
export function plan(config, node, rt, hashes = true) {
  const result = provider(config, node);
  if (result.provider === "mesa") return result;
  const requested = config.cdiDevice;
  if (requested && !/^nvidia\.com\/gpu=[A-Za-z0-9_.-]+$/.test(requested))
    throw new Failure("cdiDevice must be a qualified NVIDIA CDI device", 2);
  const matches = [];
  for (const directory of rt.info.CDISpecDirs ?? [])
    for (const p of list(directory)) {
      if (![".json", ".yaml", ".yml"].includes(path.extname(p)) || !file(p))
        continue;
      if (fs.statSync(p).size > 2 * 1024 * 1024)
        throw new Failure("CDI spec exceeds the bounded parser size", 2, {
          path: p,
        });
      let spec;
      try {
        spec = YAML.parse(read(p), { maxAliasCount: 0 });
      } catch (e) {
        throw new Failure("invalid generated CDI YAML/JSON", 3, {
          path: p,
          error: e.message,
        });
      }
      if (spec?.kind !== "nvidia.com/gpu") continue;
      validate_spec(spec, p);
      for (const device of spec.devices ?? []) {
        const name = "nvidia.com/gpu=" + device.name,
          nodes = (device.containerEdits?.deviceNodes ?? []).map(
            (n) => n.hostPath || n.path,
          );
        if (
          nodes.includes(node) &&
          (requested ? name === requested : device.name.startsWith("GPU-"))
        )
          matches.push([p, spec, device, name]);
      }
    }
  if (matches.length !== 1)
    throw new Failure(
      "select one generated CDI device matching the render node; remove stale/duplicate specs or regenerate with nvidia-ctk cdi generate",
      3,
      { candidates: matches.map(([p, , , device]) => ({ spec: p, device })) },
    );
  const [p, spec, device, name] = matches[0],
    edits = [spec.containerEdits ?? {}, device.containerEdits ?? {}],
    mounts = edits.flatMap((e) => e.mounts ?? []),
    hooks = edits.flatMap((e) => (e.hooks ?? []).map((h) => h.path)),
    missing = [
      ...mounts.filter((m) => !exists(m.hostPath)).map((m) => m.hostPath),
      ...hooks.filter((h) => !file(h)),
    ];
  if (missing.length)
    throw new Failure(
      "NVIDIA CDI is stale: regenerate it with nvidia-ctk cdi generate before launching the devbox",
      3,
      {
        spec: p,
        missing,
        refreshCommand: ["nvidia-ctk", "cdi", "generate", "--output=" + p],
      },
    );
  const inputs = [],
    libraries = new Set(),
    vendorFiles = [],
    vulkanFiles = [],
    gbmDirs = new Set();
  for (const m of mounts) {
    const target = m.containerPath,
      source = m.hostPath;
    if (
      !target.startsWith("/") ||
      target
        .slice(1)
        .split("/")
        .some((p) => ["", ".."].includes(p))
    )
      throw new Failure("unsafe CDI container mount target", 2);
    if (file(source))
      inputs.push({
        hostPath: source,
        containerPath: target,
        size: fs.statSync(source).size,
        ...(hashes ? { sha256: digest(source) } : {}),
      });
    if (
      path.basename(target).startsWith("lib") &&
      path.basename(target).includes("nvidia")
    )
      libraries.add(path.dirname(target));
    if (target.includes("/glvnd/egl_vendor.d/")) vendorFiles.push(target);
    if (target.includes("/vulkan/icd.d/")) vulkanFiles.push(target);
  }
  for (const e of edits)
    for (const h of e.hooks ?? [])
      for (const a of h.args ?? [])
        if (a.includes("::") && a.includes("/gbm/"))
          gbmDirs.add(path.dirname(a.split("::")[1]));
  if (!libraries.size || !vendorFiles.length || !gbmDirs.size)
    throw new Failure(
      "generated CDI spec lacks EGL libraries, vendor registration or GBM backend",
      3,
    );
  (env.WB_GRAPHICS_LIBRARIES ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .forEach((p) => libraries.add(p));
  return {
    ...result,
    cdiDevice: name,
    spec: { path: p, sha256: digest(p) },
    inputs,
    hooks: [...new Set(hooks)]
      .sort()
      .map((p) => ({ path: p, sha256: digest(p) })),
    libraryDirectories: [...libraries].sort(),
    eglVendorFiles: vendorFiles.sort(),
    vulkanIcdFiles: vulkanFiles.sort(),
    gbmBackendDirectories: [...gbmDirs].sort(),
  };
}
export function private_runtime_preferred(config) {
  let node = config.renderNode ?? "auto";
  if (node === "auto") {
    const nodes = list("/dev/dri").filter(
      (p) => path.basename(p).startsWith("renderD") && accessible(p),
    );
    node = nodes.length === 1 ? nodes[0] : null;
  }
  return !!node && provider(config, node).provider === "nvidia-cdi";
}
export function readiness(config, node, rt) {
  const r = provider(config, node);
  if (r.provider === "mesa") return r;
  if (!env.WB_NVIDIA_CTK || !env.WB_NVIDIA_CDI_HOOK)
    throw new Failure("NVIDIA CDI requires the Linux Nix toolkit backend", 3);
  if (rt.kind !== "podman")
    throw new Failure(
      "NVIDIA devboxes use Nix-pinned rootless Podman with private CDI; create with --runtime podman",
      3,
    );
  return { ...r, injection: "private-cdi" };
}
export function launch_plan(ws, config, node, rt, operationId) {
  const ready = readiness(config, node, rt);
  if (ready.provider === "mesa") return ready;
  const generated = prepare(ws, operationId, node, config.cdiDevice),
    result = {
      ...generated.graphics,
      ...ready,
      generationManifest: generated.manifest,
    };
  result.runtimeArguments = [
    "--cdi-spec-dir",
    path.dirname(result.spec.path),
    "--hooks-dir",
    env.WB_CONTAINER_HOOKS_DIR,
  ];
  result.runArguments = ["--device", result.cdiDevice];
  return result;
}
export function prepare(ws, operationId, renderNode = null, cdiDevice = null) {
  const tool = env.WB_NVIDIA_CTK,
    hook = env.WB_NVIDIA_CDI_HOOK;
  if (!tool || !hook)
    throw new Failure(
      "NVIDIA CDI generation requires the Linux Nix toolkit backend",
      3,
    );
  const nodes = list("/dev/dri").filter(
      (p) =>
        path.basename(p).startsWith("renderD") &&
        node_identity(p).driver === "nvidia" &&
        accessible(p),
    ),
    node = renderNode ?? (nodes.length === 1 ? nodes[0] : null);
  if (!nodes.includes(node))
    throw new Failure(
      "select one accessible NVIDIA render node for CDI generation",
      3,
      { renderNodes: nodes },
    );
  const directory = path.join(ws.state, "gpu", operationId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const p = path.join(directory, "nvidia.yaml"),
    command = [
      tool,
      "cdi",
      "generate",
      "--nvidia-cdi-hook-path",
      hook,
      "--output=" + p,
    ];
  let r;
  try {
    r = run(command, { check: false, timeout: 60000 });
  } catch (e) {
    throw new Failure("NVIDIA CDI generator could not complete", 3, {
      command,
      error: e.message,
    });
  }
  fs.writeFileSync(path.join(directory, "generator.log"), r.stderr);
  if (r.returncode)
    throw new Failure("NVIDIA CDI generator failed", r.returncode, {
      log: path.join(directory, "generator.log"),
    });
  const observed = plan({ cdiDevice }, node, {
      info: { CDISpecDirs: [directory] },
    }),
    version = run([tool, "--version"]).stdout.trim(),
    root = env.WB_NVIDIA_TOOLKIT_ROOT,
    hookRoot = path.dirname(path.dirname(hook));
  run([
    env.WB_NIX,
    "build",
    "--out-link",
    path.join(directory, "toolkit"),
    root,
  ]);
  run([
    env.WB_NIX,
    "build",
    "--out-link",
    path.join(directory, "hooks"),
    hookRoot,
  ]);
  const receipt = {
    schemaVersion: 1,
    operationId,
    state: "prepared",
    manifest: path.join(directory, "manifest.json"),
    nixLockSha256: digest(path.join(ws.root, "devenv.lock")),
    generator: {
      command,
      version,
      sha256: digest(tool),
      storeRoot: root,
      hookStoreRoot: hookRoot,
    },
    graphics: observed,
    runtime: { kind: "podman", arguments: ["--cdi-spec-dir", directory] },
    integration:
      "The launcher passes this private CDI directory directly; no system CDI setup is needed.",
  };
  write_json(receipt.manifest, receipt);
  ws.journal(operationId, {
    kind: "devbox-cdi-prepare",
    state: "prepared",
    manifest: receipt.manifest,
  });
  return receipt;
}
