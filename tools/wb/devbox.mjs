import net from "node:net";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import * as builds from "./builds.mjs";
import * as graphics from "./graphics.mjs";
import { qmp } from "./qmp.mjs";
import {
  fs,
  path,
  env,
  Failure,
  atomic_write,
  digest,
  locked,
  run,
  write_json,
  readJSON,
  read,
  resolve,
  exists,
  dir,
  file,
  symlink,
  list,
  walk,
  mkdir,
  remove,
  accessible,
  equal,
  now,
  uuid,
  randomSecret,
  sleep,
  spawn,
} from "./common.mjs";
export const file_hash = digest;
export function bounded(argv, timeout = 15) {
  try {
    return run(argv, { check: false, timeout: timeout * 1000 });
  } catch (e) {
    return { returncode: 3, stdout: "", stderr: e.message };
  }
}
export function settings(ws) {
  const config = ws.config.devbox ?? {},
    allowed = [
      "isoPath",
      "isoSha256",
      "edition",
      "containerRuntime",
      "runtimeCommand",
      "renderNode",
      "sshPort",
      "viewerPort",
      "viewer",
      "hostManifest",
      "cpus",
      "memoryMiB",
      "diskGiB",
      "guestUsername",
      "guestComputerName",
      "guestShare",
      "guestMirror",
      "guestBuildRoot",
      "rdpPort",
      "graphicsProvider",
      "cdiDevice",
    ];
  if (
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((k) => !allowed.includes(k))
  )
    throw new Failure("unknown devbox configuration field", 2);
  for (const [k, v] of Object.entries({
    guestUsername: "wbdev",
    guestComputerName: "WB-DEVBOX",
    guestShare: "Z:\\",
    guestMirror: "C:\\WinBoatDev\\src",
    guestBuildRoot: "C:\\WinBoatDev\\build",
  }))
    if ((config[k] ?? v) !== v)
      throw new Failure(k + " is a defined Windows guest contract", 2);
  if (!["auto", "tigervnc"].includes(config.viewer ?? "auto"))
    throw new Failure(
      "the implemented attachable viewer is tigervnc; standalone QEMU SDL cannot hot-attach",
      2,
    );
  return config;
}
export function name_check(name) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name))
    throw new Failure(
      "devbox name must be 1-32 lowercase letters, digits or hyphens",
      2,
    );
  return name;
}
export function location(ws, name) {
  const p = path.join(ws.state, "devboxes", name_check(name));
  if (symlink(p) || resolve(p) !== p)
    throw new Failure("devbox state path contains an escaping symlink", 2);
  return p;
}
export function owner(ws, create = false) {
  const p = path.join(ws.state, "devboxes/owner.json");
  if (!exists(p)) {
    if (!create)
      throw new Failure("no devbox owner identity; create a devbox first", 2);
    write_json(p, { schemaVersion: 1, identity: uuid() });
  }
  const data = readJSON(p);
  if (data.schemaVersion !== 1 || !/^[0-9a-f]{32}$/.test(data.identity ?? ""))
    throw new Failure("unsupported devbox owner record", 2);
  return data.identity;
}
export function load(ws, name) {
  const directory = location(ws, name),
    data = readJSON(path.join(directory, "devbox.json"));
  if (
    data.schemaVersion !== 1 ||
    data.name !== name ||
    data.owner !== owner(ws)
  )
    throw new Failure("devbox record does not belong to this workspace", 2);
  if (!/^[0-9a-f]{32}$/.test(data.identity ?? ""))
    throw new Failure("invalid devbox identity", 2);
  return [directory, data];
}
const commandValid = (c) =>
  Array.isArray(c) &&
  c.length &&
  c.every((v) => typeof v === "string" && v && !/[\n\0]/.test(v));
export function runtime_candidates(
  ws,
  config = settings(ws),
  all_kinds = false,
) {
  const choice = config.containerRuntime ?? "auto",
    override = config.runtimeCommand;
  if (!["auto", "docker", "podman"].includes(choice))
    throw new Failure("containerRuntime must be auto, docker or podman", 2);
  if (override !== undefined) {
    if (choice === "auto" || !commandValid(override))
      throw new Failure(
        "runtimeCommand requires an explicit runtime and a nonempty argument array",
        2,
      );
    if (!all_kinds) return [[choice, override]];
  }
  const commands = {
    docker: [env.WB_DOCKER],
    podman: [
      env.WB_PODMAN,
      "--root",
      path.join(ws.state, "container/storage"),
      "--runroot",
      path.join(ws.state, "container/run"),
      "--storage-driver",
      "vfs",
    ],
  };
  if (override) commands[choice] = override;
  let order = choice !== "auto" && !all_kinds ? [choice] : ["docker", "podman"];
  if (
    choice === "auto" &&
    !all_kinds &&
    graphics.private_runtime_preferred(config)
  )
    order = ["podman"];
  return order.map((k) => [k, commands[k]]);
}
export function runtime(ws, record = null) {
  const diagnostics = [],
    binding = record?.runtime,
    config = { ...settings(ws) },
    preference = record?.runtimePreference;
  if (preference && Object.keys(preference).length) {
    delete config.runtimeCommand;
    Object.assign(config, preference);
  }
  Object.assign(config, record?.graphicsPreference ?? {});
  if (
    binding &&
    (!["docker", "podman"].includes(binding.kind) ||
      !commandValid(binding.command))
  )
    throw new Failure("invalid retained devbox runtime binding", 2);
  const candidates = binding
      ? [[binding.kind, binding.command]]
      : runtime_candidates(ws, config, !!record?.image),
    available = [],
    matches = [];
  for (const [kind, command] of candidates) {
    const result = bounded([
      ...command,
      "info",
      "--format",
      kind === "docker" ? "{{json .}}" : "json",
    ]);
    if (!result.returncode) {
      let info;
      try {
        info = JSON.parse(result.stdout);
      } catch {
        diagnostics.push({
          runtime: kind,
          error: "runtime returned invalid info JSON",
        });
        continue;
      }
      if (kind === "docker" && !info.ServerVersion) continue;
      if (binding?.daemonId && info.ID !== binding.daemonId)
        throw new Failure(
          "devbox Docker daemon identity changed; refusing to control another store",
          3,
        );
      const found = { kind, command, info };
      if (binding) return found;
      available.push(found);
      if (record?.image && inspect(found, record)) matches.push(found);
      continue;
    }
    diagnostics.push({
      runtime: kind,
      error: result.stderr.trim() || result.stdout.trim(),
    });
  }
  if (record?.image && !binding) {
    if (matches.length === 1) return matches[0];
    throw new Failure(
      "legacy devbox runtime is ambiguous or its owned container is missing; preserve its disk and resolve the original runtime",
      3,
      { matches: matches.map((i) => i.kind), runtimes: diagnostics },
    );
  }
  if (available.length) return available[0];
  throw new Failure(
    "no usable container runtime; configure access to Docker or rootless Podman, or an explicit devbox.runtimeCommand",
    3,
    { runtimes: diagnostics },
  );
}
export function bind_runtime(directory, record, rt) {
  record.runtime = {
    kind: rt.kind,
    command: rt.command,
    ...(rt.kind === "docker" ? { daemonId: rt.info.ID ?? null } : {}),
  };
  write_json(path.join(directory, "devbox.json"), record);
}
export function capabilities(ws, probe_runtime = true, config = settings(ws)) {
  const nodes = list("/dev/dri").filter((p) =>
      path.basename(p).startsWith("renderD"),
    ),
    selected = config.renderNode ?? "auto",
    observations = nodes.map((p) => ({
      path: p,
      accessible: accessible(p),
      sysfsDevice: resolve(
        path.join("/sys/class/drm", path.basename(p), "device"),
      ),
      ...graphics.node_identity(p),
    }));
  let usable;
  if (selected !== "auto") {
    if (!nodes.includes(selected))
      throw new Failure("renderNode must be an existing DRM render node", 2);
    usable = accessible(selected) ? [selected] : [];
  } else usable = observations.filter((i) => i.accessible).map((i) => i.path);
  const result = {
    kvm: {
      accessible: accessible("/dev/kvm"),
      remedy: "provide read/write KVM access; local devboxes require Linux KVM",
    },
    renderNodes: observations,
    renderNode: usable.length === 1 ? usable[0] : null,
    renderRemedy:
      "select devbox.renderNode explicitly when multiple accessible GPUs exist",
    display: {
      available: !!(env.WAYLAND_DISPLAY || env.DISPLAY),
      wayland: env.WAYLAND_DISPLAY ?? null,
      x11: env.DISPLAY ?? null,
    },
  };
  if (probe_runtime)
    try {
      const found = runtime(ws);
      result.runtime = {
        available: true,
        kind: found.kind,
        command: found.command,
      };
      if (result.renderNode)
        try {
          result.graphics = {
            ready: true,
            ...graphics.readiness(config, result.renderNode, found),
          };
        } catch (e) {
          if (!(e instanceof Failure)) throw e;
          result.graphics = { ready: false, error: e.message, ...e.details };
        }
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      result.runtime = { available: false, error: e.message, ...e.details };
    }
  return result;
}
export function host_artifact(ws, p) {
  if (!p)
    throw new Failure(
      "select an exact host-stack --manifest or devbox.hostManifest; latest-run selection is forbidden",
      2,
    );
  p = ws.resolve(p);
  const verified = builds.verify(p),
    manifest = readJSON(p);
  if (manifest.target !== "host-stack" || manifest.abi !== "linux-x86_64")
    throw new Failure(
      "devbox requires a built Linux x64 host-stack manifest",
      2,
    );
  if (
    manifest.toolchain.lockSha256 !== digest(path.join(ws.root, "devenv.lock"))
  )
    throw new Failure("host artifact uses a different Nix lock", 2);
  const output = manifest.outputs[0].outputs.out;
  if (!/^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(output))
    throw new Failure(
      "host-stack output must be a retained immutable store path",
      2,
    );
  const table = (c) =>
      Array.isArray(c) ? Object.fromEntries(c.map((e) => [e.path, e])) : c,
    actual = table(
      JSON.parse(
        run([env.WB_NIX, "path-info", "--recursive", "--json", output]).stdout,
      ),
    ),
    expected = table(manifest.closure);
  if (
    !expected ||
    !equal(Object.keys(expected).sort(), Object.keys(actual).sort())
  )
    throw new Failure(
      "retained store closure differs from host artifact manifest",
      2,
    );
  for (const k of Object.keys(expected))
    if (
      ["narHash", "narSize", "references"].some(
        (f) => !equal(expected[k][f], actual[k][f]),
      )
    )
      throw new Failure("store closure identity differs: " + k, 2);
  const images = {};
  for (const entry of manifest.files) {
    const image = path.join(path.dirname(p), "files", entry.path);
    if (file(image) && entry.sha256) images[resolve(image)] = entry.sha256;
  }
  const reports = walk(path.join(output, "share")).filter((p) =>
    /\/host-(?:stack-)?smoke[^/]*\.json$/.test(p),
  );
  if (
    !reports.length ||
    !manifest.licenses?.length ||
    !manifest.symbols?.length
  )
    throw new Failure("host-stack lacks smoke, license or symbol evidence", 2);
  return {
    manifest: p,
    manifestSha256: verified.manifestSha256,
    output,
    closurePaths: Object.keys(expected).length,
    expectedImages: images,
    smoke: reports,
    artifactId: manifest.artifactId,
  };
}
export function media(
  ws,
  iso,
  expectedHash = null,
  index = null,
  edition = null,
  locale = "en-US",
) {
  // The potentially large extraction/hash is invoked by media_locked below.
  return media_locked(ws, iso, expectedHash, index, edition, locale);
}
async function media_locked(ws, iso, expectedHash, index, edition, locale) {
  const p = ws.resolve(iso);
  if (!file(p) || path.extname(p).toLowerCase() !== ".iso")
    throw new Failure("Windows media must be an existing user-supplied ISO", 2);
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale))
    throw new Failure("locale must be a Windows locale such as en-US", 2);
  const observedHash = digest(p);
  if (expectedHash && expectedHash !== observedHash)
    throw new Failure(
      "Windows ISO SHA-256 differs from the requested identity",
      2,
    );
  const cache = path.join(ws.state, "media", observedHash);
  const images = await locked(
    path.join(ws.state, "locks", "media-" + observedHash + ".lock"),
    () => {
      mkdir(cache);
      const metadata = path.join(cache, "images.xml");
      if (!exists(metadata)) {
        const extracted = path.join(cache, "install.wim");
        remove(extracted);
        const sources = run([env.WB_7ZIP, "l", "-slt", p])
          .stdout.split("\n")
          .filter(
            (l) =>
              l.startsWith("Path = ") &&
              ["sources/install.wim", "sources/install.esd"].includes(
                l.slice(7).toLowerCase(),
              ),
          )
          .map((l) => l.slice(7));
        if (sources.length !== 1)
          throw new Failure(
            "ISO must contain exactly one sources/install.wim or install.esd",
            2,
          );
        run([env.WB_7ZIP, "e", "-y", "-o" + cache, p, sources[0]]);
        const sourceFile = path.join(cache, path.basename(sources[0]));
        if (sourceFile !== extracted) fs.renameSync(sourceFile, extracted);
        try {
          run([env.WB_WIMLIB, "info", extracted, "--extract-xml=" + metadata]);
          write_json(path.join(cache, "metadata.json"), {
            schemaVersion: 1,
            isoSha256: observedHash,
            xmlSha256: digest(metadata),
          });
        } finally {
          remove(extracted);
        }
      }
      const cached = exists(path.join(cache, "metadata.json"))
        ? readJSON(path.join(cache, "metadata.json"))
        : null;
      if (!cached) {
        remove(metadata);
        throw new Failure(
          "unverified media metadata cache removed; retry the media command",
          3,
        );
      }
      if (
        cached.isoSha256 !== observedHash ||
        cached.xmlSha256 !== digest(metadata)
      )
        throw new Failure("cached Windows media metadata has drifted", 2);
      const bytes = fs.readFileSync(metadata),
        text =
          bytes[0] === 255 && bytes[1] === 254
            ? bytes.subarray(2).toString("utf16le")
            : bytes.toString("utf8").replace(/^\uFEFF/, "");
      if (XMLValidator.validate(text) !== true)
        throw new Failure("invalid Windows media XML", 2);
      const tree = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: false,
        isArray: (name) => ["IMAGE", "LANGUAGE"].includes(name),
      }).parse(text);
      return (tree.WIM?.IMAGE ?? []).map((i) => ({
        index: Number(i["@_INDEX"]),
        name: i.NAME ?? null,
        edition: i.WINDOWS?.EDITIONID ?? null,
        architecture: i.WINDOWS?.ARCH ?? null,
        languages: i.WINDOWS?.LANGUAGES?.LANGUAGE ?? [],
        build: i.WINDOWS?.VERSION?.BUILD ?? null,
      }));
    },
  );
  const matches = images.filter((i) =>
    index != null
      ? i.index === index
      : edition
        ? i.edition === edition
        : ["Enterprise", "EnterpriseS"].includes(i.edition),
  );
  if (matches.length !== 1)
    throw new Failure(
      "choose an explicit compatible --index and --edition from ISO image metadata",
      2,
      { images },
    );
  const selected = matches[0];
  if (
    selected.architecture !== "9" ||
    !selected.languages.some((l) => l.toLowerCase() === locale.toLowerCase())
  )
    throw new Failure("image is not amd64 or lacks the selected locale", 2, {
      image: selected,
    });
  if (edition && edition !== selected.edition)
    throw new Failure("requested edition and ISO index disagree", 2);
  if (
    !["Enterprise", "EnterpriseS"].includes(selected.edition) &&
    (index == null || !edition)
  )
    throw new Failure(
      "non-Enterprise media requires explicit --index and --edition",
      2,
    );
  return {
    path: p,
    sha256: observedHash,
    size: fs.statSync(p).size,
    image: selected,
    locale,
    images,
  };
}
export function provision_lock(ws) {
  const p = path.join(ws.root, "config/provision.lock.json"),
    data = readJSON(p);
  if (data.schemaVersion !== 1)
    throw new Failure("unsupported provisioning lock schema", 2);
  const ids = data.tools.map((t) => t.id),
    unresolved = data.tools
      .filter((t) => t.status !== "locked")
      .map((t) => t.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((v) => !/^[a-z][a-z0-9-]*$/.test(v))
  )
    throw new Failure("invalid or duplicate provisioning tool identities", 2);
  for (const item of data.tools)
    if (item.status === "locked") {
      if (!item.payloads?.length || !item.install || !item.probe)
        throw new Failure(
          "locked tool lacks offline payload/install/probe: " + item.id,
          2,
        );
      for (const payload of item.payloads) {
        if (!/^[0-9a-f]{64}$/.test(payload.sha256 ?? ""))
          throw new Failure("invalid provisioning payload hash: " + item.id, 2);
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(payload.file ?? "") ||
          !payload.url?.startsWith("https://")
        )
          throw new Failure(
            "invalid provisioning payload file/source: " + item.id,
            2,
          );
        const relative = (payload.relativePath ?? payload.file).replaceAll(
          "\\",
          "/",
        );
        if (
          relative.startsWith("/") ||
          relative.includes(":") ||
          relative.split("/").some((p) => ["", ".", ".."].includes(p))
        )
          throw new Failure(
            "unsafe offline installer layout path: " + item.id,
            2,
          );
      }
    }
  return { sha256: digest(p), data, unresolved };
}
const xmlEscape = (v) =>
  String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const tag = (name, content) => `<${name}>${content}</${name}>`;
const element = (n, v) => tag(n, xmlEscape(v));
const actionTag = (n, v) => `<${n} wcm:action="add">${v}</${n}>`;
export function answer_xml(password, index, locale) {
  const component = (n, content) =>
    `<component name="${n}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">${content}</component>`;
  const locales = ["InputLocale", "SystemLocale", "UILanguage", "UserLocale"]
    .map((n) => element(n, locale))
    .join("");
  const partitions = [
    [1, "EFI", 260],
    [2, "MSR", 16],
    [3, "Primary", null],
  ]
    .map(([order, kind, size]) =>
      actionTag(
        "CreatePartition",
        element("Order", order) +
          element("Type", kind) +
          element(size ? "Size" : "Extend", size ?? "true"),
      ),
    )
    .join("");
  const modifications = [
    [1, 1, "FAT32", null],
    [2, 3, "NTFS", "C"],
  ]
    .map(([order, id, format, letter]) =>
      actionTag(
        "ModifyPartition",
        element("Order", order) +
          element("PartitionID", id) +
          element("Format", format) +
          (letter ? element("Letter", letter) : ""),
      ),
    )
    .join("");
  const setup =
    tag(
      "DiskConfiguration",
      actionTag(
        "Disk",
        element("DiskID", 0) +
          element("WillWipeDisk", "true") +
          tag("CreatePartitions", partitions) +
          tag("ModifyPartitions", modifications),
      ),
    ) +
    tag(
      "ImageInstall",
      tag(
        "OSImage",
        tag(
          "InstallFrom",
          actionTag(
            "MetaData",
            element("Key", "/IMAGE/INDEX") + element("Value", index),
          ),
        ) +
          tag("InstallTo", element("DiskID", 0) + element("PartitionID", 3)) +
          element("WillShowUI", "OnError"),
      ),
    ) +
    tag(
      "UserData",
      element("AcceptEula", "true") +
        element("FullName", "wbdev") +
        element("Organization", "WinBoat"),
    );
  const secret = tag(
    "Password",
    element("Value", password) + element("PlainText", "true"),
  );
  const shell =
    tag(
      "OOBE",
      [
        "HideEULAPage",
        "HideOnlineAccountScreens",
        "HideWirelessSetupInOOBE",
        "HideLocalAccountScreen",
      ]
        .map((n) => element(n, "true"))
        .join("") + element("ProtectYourPC", 3),
    ) +
    tag(
      "UserAccounts",
      tag(
        "LocalAccounts",
        actionTag(
          "LocalAccount",
          element("Name", "wbdev") +
            element("Group", "Administrators") +
            secret,
        ),
      ),
    ) +
    tag(
      "AutoLogon",
      element("Username", "wbdev") +
        element("Enabled", "true") +
        element("LogonCount", 1) +
        secret,
    ) +
    tag(
      "FirstLogonCommands",
      actionTag(
        "SynchronousCommand",
        element("Order", 1) +
          element(
            "CommandLine",
            `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Volume | Where-Object FileSystemLabel -eq WBANSWER | ForEach-Object { & ($_.DriveLetter + ':\\Bootstrap.ps1') }"`,
          ),
      ),
    );
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">' +
    '<settings pass="windowsPE">' +
    component(
      "Microsoft-Windows-International-Core-WinPE",
      tag("SetupUILanguage", element("UILanguage", locale)) + locales,
    ) +
    component("Microsoft-Windows-Setup", setup) +
    '</settings><settings pass="specialize">' +
    component(
      "Microsoft-Windows-Shell-Setup",
      element("ComputerName", "WB-DEVBOX"),
    ) +
    '</settings><settings pass="oobeSystem">' +
    component("Microsoft-Windows-International-Core", locales) +
    component("Microsoft-Windows-Shell-Setup", shell) +
    "</settings></unattend>"
  );
}
export async function allocate_ports(ws, directory, config) {
  const used = new Set(
      list(path.join(ws.state, "devboxes"))
        .filter((p) => p !== directory && file(path.join(p, "devbox.json")))
        .flatMap((p) =>
          Object.values(readJSON(path.join(p, "devbox.json")).ports ?? {}),
        ),
    ),
    result = {},
    sockets = [];
  try {
    for (const [k, setting] of [
      ["ssh", "sshPort"],
      ["viewer", "viewerPort"],
    ]) {
      const value = config[setting] ?? "auto";
      if (
        value !== "auto" &&
        (!Number.isInteger(value) || value < 1024 || value > 65535)
      )
        throw new Failure(
          setting + " must be auto or a port from 1024 to 65535",
          2,
        );
      let allocated = false;
      for (let i = 0; i < 100; i++) {
        const server = net.createServer();
        try {
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(value === "auto" ? 0 : value, "127.0.0.1", resolve);
          });
        } catch (e) {
          throw new Failure(
            "requested devbox port is unavailable: " + e.message,
            3,
          );
        }
        const port = server.address().port;
        if (!used.has(port)) {
          sockets.push(server);
          result[k] = port;
          used.add(port);
          allocated = true;
          break;
        }
        await new Promise((r) => server.close(r));
        if (value !== "auto")
          throw new Failure("requested port belongs to another devbox", 2);
      }
      if (!allocated)
        throw new Failure("could not reserve a distinct devbox port", 3);
    }
  } finally {
    await Promise.all(sockets.map((s) => new Promise((r) => s.close(r))));
  }
  return result;
}
export function creation_resources(config, diskGiB = null) {
  diskGiB ??= config.diskGiB ?? 128;
  const cpus = config.cpus ?? 4,
    memory = config.memoryMiB ?? 8192;
  if (
    [
      [diskGiB, 64, 2048],
      [cpus, 2, 128],
      [memory, 4096, 524288],
    ].some(([v, l, u]) => !Number.isInteger(v) || v < l || v > u)
  )
    throw new Failure("invalid devbox disk/cpu/memory limits", 2);
  return [diskGiB, cpus, memory];
}
export async function create(ws, args, operationId) {
  const config = { ...settings(ws) };
  if (args.runtime) {
    config.containerRuntime = args.runtime;
    delete config.runtimeCommand;
  }
  for (const [k, a] of [
    ["renderNode", "render_node"],
    ["graphicsProvider", "graphics_provider"],
    ["cdiDevice", "cdi_device"],
  ])
    if (args[a]) config[k] = args[a];
  const iso = args.iso || config.isoPath;
  if (!iso) throw new Failure("provide --iso <user-supplied Windows ISO>", 2);
  const artifact = host_artifact(ws, args.manifest || config.hostManifest),
    selected = await media(
      ws,
      iso,
      args.iso_sha256 || config.isoSha256,
      args.index,
      args.edition || config.edition,
      args.locale,
    ),
    provision = provision_lock(ws),
    directory = location(ws, args.name),
    [diskGiB, cpus, memory] = creation_resources(config, args.disk_gib);
  const prepared = await locked(
    path.join(ws.state, "locks/devboxes.lock"),
    async () => {
      const ownerId = owner(ws, true);
      let record;
      if (exists(path.join(directory, "devbox.json"))) {
        [, record] = load(ws, args.name);
        const retainedRuntime =
          record.runtime?.kind || record.runtimePreference?.containerRuntime;
        if (args.runtime && args.runtime !== retainedRuntime)
          throw new Failure(
            "existing devbox has another runtime selection; use a new name",
            2,
          );
        if (args.disk_gib != null && record.diskGiB !== diskGiB)
          throw new Failure(
            "existing devbox has another disk capacity; use a new name",
            2,
          );
        for (const [k, a] of [
          ["renderNode", "render_node"],
          ["graphicsProvider", "graphics_provider"],
          ["cdiDevice", "cdi_device"],
        ])
          if (args[a] && args[a] !== record.graphicsPreference?.[k])
            throw new Failure(
              "existing devbox has another graphics selection; use a new name",
              2,
              { field: k },
            );
        if (
          record.media.sha256 !== selected.sha256 ||
          !equal(record.media.image, selected.image) ||
          record.media.locale !== selected.locale ||
          record.hostArtifact.manifestSha256 !== artifact.manifestSha256
        )
          throw new Failure(
            "devbox exists with different media/artifact; use a new name or guarded destroy",
            2,
          );
        if (record.provisioning.phase !== "initializing")
          return {
            state: "prepared",
            name: args.name,
            resumed: true,
            provisioning: record.provisioning,
            externalStep: "wb devbox up --name " + args.name,
          };
        if (record.provisioning.lockSha256 !== provision.sha256)
          throw new Failure(
            "provision lock changed during initialization; use a new devbox",
            2,
          );
      } else {
        if (list(directory).length)
          throw new Failure(
            "unrecognized existing devbox state; never overwrite its disks",
            2,
          );
        record = {
          schemaVersion: 1,
          name: args.name,
          identity: uuid(),
          owner: ownerId,
          media: selected,
          hostArtifact: artifact,
          ports: await allocate_ports(ws, directory, config),
          cpus,
          memoryMiB: memory,
          diskGiB,
          created: now(),
          operationId,
          image: null,
          runtimePreference: Object.fromEntries(
            ["containerRuntime", "runtimeCommand"]
              .filter((k) => k in config)
              .map((k) => [k, config[k]]),
          ),
          graphicsPreference: Object.fromEntries(
            ["renderNode", "graphicsProvider", "cdiDevice"]
              .filter((k) => k in config)
              .map((k) => [k, config[k]]),
          ),
          initialBootPending: true,
          provisioning: {
            phase: "initializing",
            installed: false,
            verified: false,
            lockSha256: provision.sha256,
            unresolvedInputs: provision.unresolved,
          },
        };
        write_json(path.join(directory, "devbox.json"), record);
      }
      mkdir(directory);
      fs.chmodSync(directory, 0o700);
      const secrets = path.join(directory, "secrets");
      mkdir(secrets);
      if (!exists(path.join(secrets, "password")))
        atomic_write(
          path.join(secrets, "password"),
          randomSecret() + "\n",
          0o600,
        );
      const password = read(path.join(secrets, "password")).trim();
      if (!exists(path.join(secrets, "ssh")))
        run([
          env.WB_SSH_KEYGEN,
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-f",
          path.join(secrets, "ssh"),
          "-C",
          "winboat-devbox",
        ]);
      const payload = path.join(directory, "answer");
      mkdir(payload);
      if (!exists(path.join(payload, "ssh_host_ed25519_key")))
        run([
          env.WB_SSH_KEYGEN,
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-f",
          path.join(payload, "ssh_host_ed25519_key"),
          "-C",
          "WB-DEVBOX",
        ]);
      atomic_write(
        path.join(payload, "Autounattend.xml"),
        answer_xml(password, selected.image.index, selected.locale),
      );
      for (const p of list(env.WB_DEVBOX_PAYLOADS))
        fs.copyFileSync(p, path.join(payload, path.basename(p)));
      fs.copyFileSync(
        path.join(secrets, "ssh.pub"),
        path.join(payload, "authorized_keys"),
      );
      fs.copyFileSync(
        path.join(ws.root, "config/provision.lock.json"),
        path.join(payload, "provision.lock.json"),
      );
      atomic_write(path.join(payload, "share-password"), password);
      run([
        env.WB_XORRISO,
        "-as",
        "mkisofs",
        "-J",
        "-r",
        "-V",
        "WBANSWER",
        "-o",
        path.join(directory, "answer.partial.iso"),
        payload,
      ]);
      fs.renameSync(
        path.join(directory, "answer.partial.iso"),
        path.join(directory, "answer.iso"),
      );
      if (!exists(path.join(directory, "disk.qcow2"))) {
        const tmp = path.join(directory, "disk.partial.qcow2");
        remove(tmp);
        run([
          path.join(artifact.output, "bin/qemu-img"),
          "create",
          "-f",
          "qcow2",
          tmp,
          record.diskGiB + "G",
        ]);
        fs.renameSync(tmp, path.join(directory, "disk.qcow2"));
      }
      if (!exists(path.join(directory, "nvram.fd")))
        fs.copyFileSync(
          path.join(artifact.output, "share/qemu/edk2-i386-vars.fd"),
          path.join(directory, "nvram.fd"),
        );
      record.provisioning.phase = "prepared";
      const hostKey = read(
        path.join(payload, "ssh_host_ed25519_key.pub"),
      ).split(/\s+/);
      atomic_write(
        path.join(directory, "known_hosts"),
        `[127.0.0.1]:${record.ports.ssh} ${hostKey[0]} ${hostKey[1]}\n`,
      );
      write_json(path.join(directory, "devbox.json"), record);
      ws.journal(operationId, {
        kind: "devbox-create",
        state: "prepared",
        name: args.name,
        mediaSha256: selected.sha256,
        manifestSha256: artifact.manifestSha256,
        provisioning: record.provisioning,
      });
      const { path: omitted, ...mediaInfo } = selected;
      return {
        state: "prepared",
        name: args.name,
        ports: record.ports,
        media: mediaInfo,
        provisioning: record.provisioning,
        externalStep: "wb devbox up --name " + args.name,
      };
    },
  );
  return args.start ? up(ws, args.name, operationId) : prepared;
}
export const container_name = (record) => "wbdev-" + record.identity;
export function inspect(rt, record) {
  const result = run(
    [...rt.command, "container", "inspect", container_name(record)],
    { check: false },
  );
  if (result.returncode) {
    const info = bounded([...rt.command, "info"]);
    if (info.returncode)
      throw new Failure("container runtime disconnected during inspection", 3, {
        error: info.stderr,
      });
    if (
      !["no such", "not found", "does not exist"].some((v) =>
        (result.stderr + result.stdout).toLowerCase().includes(v),
      )
    )
      throw new Failure("container inspection failed", 3, {
        error: result.stderr,
      });
    return null;
  }
  const data = JSON.parse(result.stdout)[0],
    labels = data.Config?.Labels ?? {};
  if (
    labels["org.winboat.owner"] !== record.owner ||
    labels["org.winboat.identity"] !== record.identity
  )
    throw new Failure(
      "container ownership labels differ; refusing to control it",
      2,
    );
  if (record.image && data.Image !== record.image.id)
    throw new Failure("container image differs from retained devbox image", 2);
  return data;
}
export function build_image(ws, directory, record, rt) {
  const provisionPath = path.join(directory, "answer/provision.lock.json");
  if (digest(provisionPath) !== record.provisioning.lockSha256)
    throw new Failure("prepared guest provisioning lock changed", 2);
  const spec = {
    schemaVersion: 1,
    system: env.WB_SYSTEM,
    hostStack: record.hostArtifact.output,
    identity: record.identity,
    manifestSha256: record.hostArtifact.manifestSha256,
    lockSha256: digest(path.join(ws.root, "devenv.lock")),
    provisionLock: provisionPath,
    provisionLockSha256: record.provisioning.lockSha256,
  };
  write_json(path.join(directory, "image-spec.json"), spec);
  const command = [
      env.WB_NIX,
      "build",
      "--json",
      "--out-link",
      path.join(directory, "container-image"),
      "--file",
      env.WB_DEVBOX_EXPRESSION,
      "--argstr",
      "nixpkgsPath",
      env.WB_NIXPKGS,
      "--argstr",
      "specification",
      path.join(directory, "image-spec.json"),
    ],
    rootCommand = [...command];
  rootCommand[rootCommand.indexOf("--out-link") + 1] = path.join(
    directory,
    "container-runtime",
  );
  rootCommand.push("winboatRuntime");
  const log = fs.openSync(path.join(directory, "image-build.log"), "a");
  let rooted, result;
  try {
    rooted = run(rootCommand, { stderr: log, check: false });
    if (rooted.returncode)
      throw new Failure(
        "Nix devbox runtime closure build failed",
        rooted.returncode,
        { log: path.join(directory, "image-build.log") },
      );
    result = run(command, { stderr: log, check: false });
  } finally {
    fs.closeSync(log);
  }
  if (result.returncode)
    throw new Failure("Nix devbox image build failed", result.returncode, {
      log: path.join(directory, "image-build.log"),
    });
  const output = JSON.parse(result.stdout)[0],
    archive = output.outputs.out,
    loadCommand = [
      ...rt.command,
      "load",
      ...(rt.kind === "podman"
        ? ["--signature-policy", env.WB_CONTAINER_POLICY]
        : []),
      "--input",
      archive,
    ];
  if (rt.kind === "podman") {
    const scratchRoot = path.join(ws.state, "container/import-tmp");
    if (resolve(scratchRoot) !== scratchRoot)
      throw new Failure("image import scratch path contains a symlink", 2);
    mkdir(scratchRoot);
    const scratch = fs.mkdtempSync(path.join(scratchRoot, "devbox-"));
    try {
      run(loadCommand, { env: { ...env, TMPDIR: scratch } });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } else run(loadCommand);
  const data = JSON.parse(
      run([
        ...rt.command,
        "image",
        "inspect",
        "winboat-devbox:" + record.identity,
      ]).stdout,
    )[0],
    imageId = data.Id || data.ID;
  if (!imageId)
    throw new Failure("runtime did not report an immutable image identity", 3);
  const labels = data.Config?.Labels ?? {};
  if (labels["org.winboat.manifest-sha256"] !== spec.manifestSha256)
    throw new Failure("imported image manifest label differs", 3);
  if (labels["org.winboat.provision-lock-sha256"] !== spec.provisionLockSha256)
    throw new Failure("imported image provisioning lock label differs", 3);
  return {
    id: imageId,
    archiveSha256: digest(archive),
    output: archive,
    runtimeRoot: JSON.parse(rooted.stdout)[0].outputs.out,
    derivation: output.drvPath,
    lockSha256: spec.lockSha256,
    provisionLockSha256: spec.provisionLockSha256,
    hostStack: spec.hostStack,
    manifestSha256: spec.manifestSha256,
  };
}
export async function up(ws, name, operationId, rebuildImage = false) {
  return locked(
    path.join(ws.state, "locks", "devbox-" + name_check(name) + ".lock"),
    async () => {
      const [directory, record] = load(ws, name),
        rt = runtime(ws, record);
      bind_runtime(directory, record, rt);
      const existing = inspect(rt, record);
      if (existing?.State?.Running) {
        if (rebuildImage)
          throw new Failure(
            "stop the devbox before rebuilding its container image",
            2,
          );
        return status(ws, name, rt);
      }
      const graphicsConfig = { ...settings(ws), ...record.graphicsPreference },
        observed = capabilities(ws, false, graphicsConfig);
      if (!observed.kvm.accessible || !observed.renderNode)
        throw new Failure(
          "KVM or a selected accessible render node is missing",
          3,
          { capabilities: observed },
        );
      const selectedGraphics = graphics.launch_plan(
          ws,
          graphicsConfig,
          observed.renderNode,
          rt,
          operationId,
        ),
        artifact = host_artifact(ws, record.hostArtifact.manifest);
      if (artifact.manifestSha256 !== record.hostArtifact.manifestSha256)
        throw new Failure("selected host artifact changed after creation", 2);
      if (digest(record.media.path) !== record.media.sha256)
        throw new Failure("Windows media changed after creation", 2);
      if (!record.image || rebuildImage) {
        if (record.image) {
          const previous = record.image;
          (record.previousImages ??= []).push(previous);
          const retained = path.join(
            directory,
            "images",
            previous.archiveSha256,
          );
          mkdir(path.dirname(retained));
          if (!exists(retained))
            run([env.WB_NIX, "build", "--out-link", retained, previous.output]);
          if (previous.runtimeRoot)
            run([
              env.WB_NIX,
              "build",
              "--out-link",
              retained + "-runtime",
              previous.runtimeRoot,
            ]);
        }
        record.image = build_image(ws, directory, record, rt);
        write_json(path.join(directory, "devbox.json"), record);
      }
      if (record.image.lockSha256 !== digest(path.join(ws.root, "devenv.lock")))
        throw new Failure("devbox image lock differs; create a new devbox", 2);
      if (existing) run([...rt.command, "rm", container_name(record)]);
      write_json(path.join(directory, "launch.json"), {
        cpus: record.cpus,
        memoryMiB: record.memoryMiB,
        renderNode: observed.renderNode,
        attachMedia: !record.provisioning.verified,
        graphics: selectedGraphics,
        provisionLockSha256: record.provisioning.lockSha256,
        initialBoot: record.initialBootPending ?? false,
        expectedImages: artifact.expectedImages,
      });
      remove(path.join(directory, "host-observation.json"));
      const command = [
        ...rt.command,
        ...(selectedGraphics.runtimeArguments ?? []),
        "run",
        "--pull=never",
        ...(rt.kind === "podman" ? ["--group-add", "keep-groups"] : []),
        "--detach",
        "--name",
        container_name(record),
        "--label",
        "org.winboat.owner=" + record.owner,
        "--label",
        "org.winboat.identity=" + record.identity,
        "--device",
        "/dev/kvm",
        "--publish",
        `127.0.0.1:${record.ports.ssh}:22`,
        "--publish",
        `127.0.0.1:${record.ports.viewer}:5900`,
        "--mount",
        `type=bind,source=${directory},destination=/state`,
        "--mount",
        `type=bind,source=${ws.root},destination=/workspace,readonly`,
        "--mount",
        `type=bind,source=${record.media.path},destination=/media/windows.iso,readonly`,
        ...(selectedGraphics.provider === "nvidia-cdi"
          ? selectedGraphics.runArguments
          : ["--device", observed.renderNode]),
      ];
      const privateShare = path.join(directory, "empty-share");
      mkdir(privateShare);
      if (exists(path.join(ws.root, "docs/user")))
        command.push(
          "--mount",
          `type=bind,source=${privateShare},destination=/workspace/docs/user,readonly`,
        );
      command.push(record.image.id);
      if ([directory, ws.root, record.media.path].some((p) => p.includes(",")))
        throw new Failure(
          "container mount paths containing commas are unsupported",
          2,
        );
      run(command);
      record.provisioning.phase = "booting";
      write_json(path.join(directory, "devbox.json"), record);
      for (let i = 0; i < 300; i++) {
        const observation = path.join(directory, "host-observation.json");
        if (exists(observation)) {
          const data = readJSON(observation);
          if (data.state === "running" && data.loaded) {
            record.initialBootPending = false;
            write_json(path.join(directory, "devbox.json"), record);
            ws.journal(operationId, {
              kind: "devbox-up",
              state: "running",
              name,
              image: record.image,
              hostObservation: observation,
            });
            return status(ws, name, rt);
          }
          if (data.state === "failed")
            throw new Failure(
              "container QEMU identity/startup check failed",
              3,
              { observation: data, log: path.join(directory, "qemu.log") },
            );
        }
        const current = inspect(rt, record);
        if (!current?.State?.Running)
          throw new Failure(
            "devbox container exited before QEMU identity verification",
            3,
            {
              log: path.join(directory, "qemu.log"),
              container: container_name(record),
            },
          );
        await sleep(100);
      }
      throw new Failure(
        "devbox QEMU startup timed out; inspect logs before retrying",
        3,
        { name },
      );
    },
  );
}
export async function migrate_host(ws, name, manifest, operationId) {
  return locked(
    path.join(ws.state, "locks", "devbox-" + name_check(name) + ".lock"),
    () => {
      const [directory, record] = load(ws, name),
        rt = runtime(ws, record),
        existing = inspect(rt, record);
      if (existing?.State?.Running)
        throw new Failure(
          "stop the devbox before migrating its host artifact",
          2,
        );
      if (!record.image || !record.provisioning.verified)
        throw new Failure(
          "host migration requires an existing verified devbox image",
          2,
        );
      const previous = host_artifact(ws, record.hostArtifact.manifest);
      if (previous.manifestSha256 !== record.hostArtifact.manifestSha256)
        throw new Failure("retained host artifact changed before migration", 2);
      const selected = host_artifact(ws, manifest),
        old = readJSON(previous.manifest),
        fresh = readJSON(selected.manifest);
      if (
        fresh.mode !== "release" ||
        Object.values(fresh.sources).some(
          (s) => s.diffSha256 || s.untracked?.length,
        )
      )
        throw new Failure(
          "host migration requires a clean release artifact",
          2,
        );
      for (const component of ["virglrenderer", "venus-protocol"]) {
        const before = old.sources[component],
          after = fresh.sources[component];
        if (
          !before.narHash ||
          !after.narHash ||
          ["revision", "diffSha256", "narHash"].some(
            (k) => !equal(before[k], after[k]),
          )
        )
          throw new Failure(
            "host migration cannot change the renderer or protocol; use a new guest",
            2,
            { component },
          );
      }
      if (selected.manifestSha256 === previous.manifestSha256)
        return {
          state: "unchanged",
          name,
          hostArtifact: selected,
          loaded: false,
        };
      const retained = path.join(directory, "host-migrations", operationId);
      mkdir(retained);
      write_json(path.join(retained, "before.json"), record);
      const image = record.image,
        roots = [[image.archiveSha256, image.output]];
      if (image.runtimeRoot)
        roots.push([image.archiveSha256 + "-runtime", image.runtimeRoot]);
      for (const [label, output] of roots)
        run([
          env.WB_NIX,
          "build",
          "--out-link",
          path.join(retained, label),
          output,
        ]);
      const receipt = {
        kind: "devbox-host-migration",
        state: "building-image",
        name,
        identity: record.identity,
        previousHostArtifact: previous,
        selectedHostArtifact: selected,
        previousRecord: path.join(retained, "before.json"),
        loaded: false,
      };
      ws.journal(operationId, receipt);
      const candidate = structuredClone(record);
      candidate.hostArtifact = selected;
      try {
        candidate.image = build_image(ws, directory, candidate, rt);
        const current = inspect(rt, record);
        if (
          current &&
          (current.State?.Running || !existing || current.Id !== existing.Id)
        )
          throw new Failure(
            "container changed during host migration; retained guest selection was preserved",
            2,
          );
        if (current) {
          const logs = run([...rt.command, "logs", container_name(record)], {
            check: false,
          });
          fs.writeFileSync(
            path.join(retained, "container.log"),
            logs.stdout + logs.stderr,
          );
          run([...rt.command, "rm", container_name(record)]);
        }
        (candidate.previousHostArtifacts ??= []).push({
          operationId,
          hostArtifact: record.hostArtifact,
          image,
          record: path.join(retained, "before.json"),
        });
        candidate.hostMigration = {
          operationId,
          state: "prepared",
          previousRecord: path.join(retained, "before.json"),
        };
        write_json(path.join(directory, "devbox.json"), candidate);
        Object.assign(receipt, {
          state: "prepared",
          image: candidate.image,
          externalStep:
            "Start this devbox and verify its loaded host and Windows graphics identities.",
        });
      } catch (e) {
        Object.assign(receipt, { state: "failed", error: e.message });
        ws.journal(operationId, receipt);
        throw e;
      }
      ws.journal(operationId, receipt);
      return receipt;
    },
  );
}
export function status(ws, name, rt = null) {
  const [directory, record] = load(ws, name),
    result = {
      name,
      state: "prepared",
      ports: record.ports,
      image: record.image,
      provisioning: record.provisioning,
      desiredHostArtifact: record.hostArtifact.manifestSha256,
      hostObservation: null,
      guestObservation: null,
      loaded: false,
    };
  try {
    rt ||= runtime(ws, record);
    result.runtime = { kind: rt.kind, command: rt.command };
    const data = inspect(rt, record);
    result.state = data?.State?.Running
      ? "running"
      : data
        ? "stopped"
        : "prepared";
    if (data)
      result.container = { id: data.Id, state: data.State, image: data.Image };
  } catch (e) {
    if (!(e instanceof Failure) || e.code !== 3) throw e;
    result.state = "runtime-unavailable";
    result.runtimeError = { message: e.message, ...e.details };
  }
  for (const [filename, k] of [
    ["host-observation.json", "hostObservation"],
    ["guest-observation.json", "guestObservation"],
  ]) {
    const p = path.join(directory, filename);
    if (exists(p)) result[k] = readJSON(p);
  }
  result.loaded =
    result.state === "running" && !!result.hostObservation?.loaded;
  return result;
}
export async function qmp_observe(directory, command, arguments_ = {}) {
  if (!["query-cpus-fast", "memsave"].includes(command))
    throw new Failure("unsupported read-only QMP observation", 2);
  try {
    const r = await qmp(path.join(directory, "qmp.sock"), [
      { execute: command, arguments: arguments_ },
    ]);
    return { greeting: r.greeting, response: r.responses[0] };
  } catch (e) {
    if (e instanceof Failure) throw e;
    throw new Failure("QMP observation unavailable", 76, { error: e.message });
  }
}
export async function qmp_powerdown(directory) {
  try {
    await qmp(
      path.join(directory, "qmp.sock"),
      [{ execute: "system_powerdown" }],
      5000,
    );
  } catch (e) {
    throw new Failure("QMP unavailable; refusing an unclean shutdown", 3, {
      error: e.message,
    });
  }
}
export async function down(
  ws,
  name,
  operationId,
  force = false,
  timeout = 120,
) {
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600)
    throw new Failure("shutdown timeout must be from 10 to 600 seconds", 2);
  return locked(
    path.join(ws.state, "locks", "devbox-" + name_check(name) + ".lock"),
    async () => {
      const [directory, record] = load(ws, name),
        rt = runtime(ws, record);
      bind_runtime(directory, record, rt);
      const data = inspect(rt, record);
      let result;
      if (data?.State?.Running) {
        if (force) {
          run([...rt.command, "stop", "--time", "15", container_name(record)]);
          ws.journal(operationId, {
            kind: "devbox-down",
            state: "stopped",
            name,
            cleanShutdown: false,
          });
          return {
            name,
            state: "stopped",
            loaded: false,
            cleanShutdown: false,
          };
        }
        const shutdown = { method: "acpi", timeoutSeconds: timeout };
        if (record.provisioning.verified) {
          const encoded = Buffer.from(
              read(path.join(env.WB_DEVBOX_PAYLOADS, "Shutdown.ps1")),
              "utf16le",
            ).toString("base64"),
            response = bounded(
              [
                ...ssh_command(directory, record),
                "powershell.exe -NoProfile -EncodedCommand " + encoded,
              ],
              20,
            );
          shutdown.sshExitCode = response.returncode;
          if (!response.returncode) shutdown.method = "ssh";
          else
            shutdown.sshError =
              response.stderr.trim() || response.stdout.trim();
        }
        if (shutdown.method === "acpi") await qmp_powerdown(directory);
        const deadline = performance.now() + timeout * 1000;
        let current = data;
        while (performance.now() < deadline) {
          current = inspect(rt, record);
          if (!current?.State?.Running) break;
          await sleep(500);
        }
        if (current?.State?.Running) {
          ws.journal(operationId, {
            kind: "devbox-down",
            state: "timeout",
            name,
            shutdown,
          });
          throw new Failure(
            "guest did not shut down; VM preserved running",
            3,
            { name, shutdown },
          );
        }
        if (!current || current.State.ExitCode !== 0)
          throw new Failure(
            "container disappeared or exited abnormally during shutdown; guest disk preserved",
            3,
            { name, shutdown, containerState: current?.State ?? null },
          );
        result = {
          name,
          state: "stopped",
          loaded: false,
          cleanShutdown: true,
          shutdown,
        };
      } else
        result = { name, state: "stopped", loaded: false, cleanShutdown: null };
      ws.journal(operationId, { kind: "devbox-down", ...result });
      return result;
    },
  );
}
export async function destroy(ws, name, confirmation, operationId) {
  return locked(path.join(ws.state, "locks/devboxes.lock"), () =>
    locked(
      path.join(ws.state, "locks", "devbox-" + name_check(name) + ".lock"),
      () => {
        const [directory, record] = load(ws, name);
        if (confirmation !== record.identity)
          throw new Failure(
            "destroy requires --confirm " +
              record.identity +
              "; this permanently deletes this devbox's disks and keys",
            2,
          );
        const rt = runtime(ws, record),
          data = inspect(rt, record);
        if (data?.State?.Running)
          throw new Failure("stop this devbox before destroying it", 2);
        if (data) run([...rt.command, "rm", container_name(record)]);
        if (symlink(directory) || resolve(directory) !== location(ws, name))
          throw new Failure("devbox deletion boundary changed", 2);
        fs.rmSync(directory, { recursive: true });
        ws.journal(operationId, {
          kind: "devbox-destroy",
          name,
          state: "destroyed",
          identity: confirmation,
        });
        return { name, state: "destroyed" };
      },
    ),
  );
}
export function ssh_command(directory, record) {
  return [
    env.WB_SSH,
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UserKnownHostsFile=" + path.join(directory, "known_hosts"),
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-i",
    path.join(directory, "secrets/ssh"),
    "-p",
    String(record.ports.ssh),
    "wbdev@127.0.0.1",
  ];
}
export function guest_status(ws, name, operationId) {
  const [directory, record] = load(ws, name);
  if (!file(path.join(directory, "known_hosts")))
    throw new Failure(
      "guest host key has not been authenticated; provisioning must export its host key before SSH observation",
      3,
    );
  const script =
      "Get-Content -Raw -LiteralPath 'C:\\ProgramData\\WinBoatDev\\provisioning.json'",
    command =
      "powershell.exe -NoProfile -EncodedCommand " +
      Buffer.from(script, "utf16le").toString("base64"),
    observed = JSON.parse(
      run([...ssh_command(directory, record), command]).stdout.replace(
        /^\uFEFF/,
        "",
      ),
    );
  if (
    observed.schemaVersion !== 1 ||
    observed.computerName !== "WB-DEVBOX" ||
    observed.lockSha256 !== record.provisioning.lockSha256
  )
    throw new Failure("unexpected guest identity or inventory schema", 3);
  write_json(path.join(directory, "guest-observation.json"), {
    observed: now(),
    transport: "key-authenticated-ssh",
    ...observed,
  });
  Object.assign(record.provisioning, {
    phase: observed.phase,
    installed: observed.phase === "verified",
    verified:
      observed.phase === "verified" && observed.signedDriverLoaded === true,
  });
  write_json(path.join(directory, "devbox.json"), record);
  ws.journal(operationId, {
    kind: "devbox-guest-status",
    state: "observed",
    name,
    guestObservation: path.join(directory, "guest-observation.json"),
  });
  return observed;
}
const processIdentity = (pid) => ({
  executable: fs.realpathSync(`/proc/${pid}/exe`),
  startTick: read(`/proc/${pid}/stat`)
    .slice(read(`/proc/${pid}/stat`).lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19],
});
export async function viewer(ws, name, action, operationId) {
  const [directory, record] = load(ws, name),
    p = path.join(directory, "viewer.json"),
    previous = exists(p) ? readJSON(p) : {},
    pid = previous.pid;
  let running = false;
  if (pid)
    try {
      const observed = processIdentity(pid);
      running =
        observed.executable === previous.executable &&
        observed.startTick === previous.startTick;
    } catch {}
  if (action === "status")
    return {
      state: running ? "open" : "closed",
      backend: "tigervnc",
      pid: running ? pid : null,
    };
  if (action === "close") {
    if (running) {
      process.kill(pid, "SIGTERM");
      let closed = false;
      for (let i = 0; i < 20; i++) {
        if (
          (await viewer(ws, name, "status", operationId)).state === "closed"
        ) {
          closed = true;
          break;
        }
        await sleep(100);
      }
      if (!closed)
        throw new Failure("viewer did not close; VM remains running", 3);
    }
    return { state: "closed", backend: "tigervnc", vmStopped: false };
  }
  if (running) return { state: "open", backend: "tigervnc", pid };
  if (!capabilities(ws, false).display.available)
    throw new Failure(
      "viewer requires an interactive display; the headless VM can remain running",
      3,
    );
  if (status(ws, name).state !== "running")
    throw new Failure("start this devbox before opening its viewer", 3);
  const log = fs.openSync(path.join(directory, "viewer.log"), "a"),
    child = spawn(
      env.WB_VNCVIEWER,
      [
        "-Shared",
        "-SecurityTypes",
        "None",
        `127.0.0.1::${record.ports.viewer}`,
      ],
      { detached: true, stdio: ["ignore", log, log] },
    );
  fs.closeSync(log);
  let error;
  child.on("error", (e) => {
    error = e;
  });
  child.unref();
  await sleep(200);
  if (error || child.exitCode !== null)
    throw new Failure("VNC viewer exited on startup", 3, {
      log: path.join(directory, "viewer.log"),
    });
  const observation = {
    pid: child.pid,
    ...processIdentity(child.pid),
    backend: "tigervnc",
  };
  write_json(p, observation);
  ws.journal(operationId, {
    kind: "devbox-viewer",
    state: "open",
    name,
    ...observation,
  });
  return {
    state: "open",
    backend: "tigervnc",
    pid: child.pid,
    vmStopped: false,
  };
}
export async function dispatch(ws, args, operationId) {
  if (
    ["run", "job", "mirror", "registry", "install", "build", "smoke"].includes(
      args.action,
    )
  )
    return (await import("./windows.mjs")).dispatch(ws, args, operationId);
  switch (args.action) {
    case "cdi":
      return graphics.prepare(ws, operationId, args.render_node);
    case "capabilities":
      return capabilities(ws);
    case "media":
      return media(
        ws,
        args.iso,
        args.iso_sha256,
        args.index,
        args.edition,
        args.locale,
      );
    case "create":
      return create(ws, args, operationId);
    case "status":
      return {
        ...status(ws, args.name),
        identity: load(ws, args.name)[1].identity,
      };
    case "logs": {
      const [directory] = load(ws, args.name),
        logs = {};
      for (const p of list(directory).filter((p) => p.endsWith(".log"))) {
        const fd = fs.openSync(p, "r"),
          buffer = Buffer.alloc(Math.min(fs.statSync(p).size, 65536));
        try {
          fs.readSync(
            fd,
            buffer,
            0,
            buffer.length,
            Math.max(0, fs.statSync(p).size - 65536),
          );
          logs[path.basename(p)] = buffer.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      }
      return { name: args.name, logs, boundedBytesPerLog: 65536 };
    }
    case "up":
      return up(ws, args.name, operationId, args.rebuild_image);
    case "migrate-host":
      return migrate_host(ws, args.name, args.manifest, operationId);
    case "down":
      return down(ws, args.name, operationId, args.force, args.timeout);
    case "restart":
      await down(ws, args.name, operationId, false, args.timeout);
      return up(ws, args.name, operationId);
    case "destroy":
      return destroy(ws, args.name, args.confirm, operationId);
    case "viewer":
      return viewer(ws, args.name, args.viewer_action, operationId);
    case "guest-status":
      return guest_status(ws, args.name, operationId);
    default:
      throw new Failure("unknown devbox operation", 2);
  }
}
