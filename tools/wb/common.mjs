import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { isDeepStrictEqual as equal } from "node:util";
export { fs, path, os, spawn, equal };
export const env = process.env;
export class Failure extends Error {
  constructor(message, code = 1, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function run(argv, options = {}) {
  argv = argv.map(String);
  const p = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    timeout: options.timeout,
    ...(options.stdio ? { stdio: options.stdio } : {}),
    ...(options.stderr !== undefined
      ? { stdio: ["pipe", "pipe", options.stderr] }
      : {}),
  });
  if (p.error)
    throw new Failure(p.error.message, p.error.code === "ETIMEDOUT" ? 75 : 1, {
      command: argv,
    });
  const result = {
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
    returncode: p.status ?? 128,
  };
  if (options.check !== false && result.returncode)
    throw new Failure(
      result.stderr.trim() || result.stdout.trim() || String(argv),
      result.returncode,
      { command: argv },
    );
  return result;
}
export function git(directory, ...args) {
  const options = typeof args.at(-1) === "object" ? args.pop() : {};
  const ambient = { ...env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete ambient[key];
  // Only explicitly supplied internal index overrides can affect scoped commits.
  return run([env.WB_REAL_GIT, "-C", directory, ...args], {
    ...options,
    env: { ...ambient, ...options.env },
  });
}
export const identity = () => "op-" + crypto.randomUUID().replaceAll("-", "");
export const uuid = () => crypto.randomUUID().replaceAll("-", "");
export const randomSecret = () => crypto.randomBytes(30).toString("base64url");
export const hash = (value, algorithm = "sha256") =>
  crypto.createHash(algorithm).update(value).digest("hex");
export function digest(file) {
  const h = crypto.createHash("sha256"),
    fd = fs.openSync(file, "r"),
    buffer = Buffer.alloc(4 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
      h.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}
export function exists(p) {
  return fs.existsSync(p);
}
export function stat(p) {
  try {
    return fs.statSync(p);
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes(e.code)) return null;
    throw e;
  }
}
export function symlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes(e.code)) return false;
    throw e;
  }
}
export const file = (p) => stat(p)?.isFile() ?? false;
export const dir = (p) => stat(p)?.isDirectory() ?? false;
export const mkdir = (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 });
export const read = (p) => fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
export const readJSON = (p) => JSON.parse(read(p));
export const remove = (p) => {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
};
export const now = () => Date.now() / 1000;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function accessible(p, mode = fs.constants.R_OK | fs.constants.W_OK) {
  try {
    fs.accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
}
export function resolve(p) {
  p = path.resolve(
    p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p,
  );
  if (exists(p)) return fs.realpathSync(p);
  const parent = path.dirname(p);
  return parent === p ? p : path.join(resolve(parent), path.basename(p));
}
export const within = (p, boundary) =>
  p === boundary ||
  (!path.relative(boundary, p).startsWith(".." + path.sep) &&
    path.relative(boundary, p) !== ".." &&
    !path.isAbsolute(path.relative(boundary, p)));
export function list(p) {
  return dir(p)
    ? fs
        .readdirSync(p)
        .sort()
        .map((n) => path.join(p, n))
    : [];
}
export function walk(root) {
  // Path ordering compares components: firmware/a precedes firmware-old/a.
  // Keep this traversal order for existing artifact and snapshot identities.
  return list(root).flatMap((p) => [
    p,
    ...(!symlink(p) && dir(p) ? walk(p) : []),
  ]);
}
export function atomic_write(p, text, mode) {
  mkdir(path.dirname(p));
  const tmp = path.join(path.dirname(p), "." + path.basename(p) + "-" + uuid());
  const fd = fs.openSync(tmp, "wx", mode ?? (stat(p)?.mode & 0o777 || 0o600));
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, p);
    const d = fs.openSync(path.dirname(p), "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } finally {
    remove(tmp);
  }
}
export const write_json = (p, value) =>
  atomic_write(p, JSON.stringify(value, null, 2) + "\n");
export async function locked(p, callback) {
  mkdir(path.dirname(p));
  // Kernel flock interoperates with existing workers. EOF releases the lock even
  // if this Node process dies; no persistent stale lock ownership is invented.
  const child = spawn(
    env.WB_FLOCK,
    [
      "--exclusive",
      p,
      env.WB_NODE || process.execPath,
      new URL("./lock-holder.mjs", import.meta.url).pathname,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let diagnostic = "";
  child.stderr.on("data", (b) => {
    diagnostic += b;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
      child.once("close", (code) =>
        reject(
          new Failure("lock acquisition failed: " + diagnostic, code || 1),
        ),
      );
    });
    return await callback();
  } finally {
    child.stdin.end();
    await closed;
  }
}
export async function locks(paths, callback) {
  paths = [...new Set(paths)].sort();
  return paths.length
    ? locked(paths[0], () => locks(paths.slice(1), callback))
    : callback();
}
export function which(name) {
  return (
    (env.PATH ?? "")
      .split(path.delimiter)
      .map((p) => path.join(p, name))
      .find((p) => file(p) && accessible(p, fs.constants.X_OK)) ?? null
  );
}
export function parse_pins(text) {
  const regex =
    /\s+|#[^\n]*|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_-]*|[0-9]+|[{}=;]/gy;
  const tokens = [];
  let at = 0;
  while (at < text.length) {
    regex.lastIndex = at;
    const m = regex.exec(text);
    if (!m) throw new Failure("pins.nix must contain literal data only", 2);
    at = regex.lastIndex;
    if (!/^\s|^#/.test(m[0])) tokens.push(m[0]);
  }
  let pos = 0;
  const take = (expected) => {
    const t = tokens[pos++];
    if (t === undefined || (expected !== undefined && t !== expected))
      throw new Failure("invalid pins.nix literal", 2);
    return t;
  };
  const value = () => {
    if (tokens[pos] === "{") {
      take("{");
      const result = {};
      while (tokens[pos] !== "}") {
        let key = take();
        if (key.startsWith('"')) key = JSON.parse(key);
        if (
          Object.hasOwn(result, key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new Failure("duplicate or invalid pin key: " + key, 2);
        take("=");
        result[key] = value();
        take(";");
      }
      take("}");
      return result;
    }
    const t = take();
    if (t === "null") return null;
    if (/^\d+$/.test(t)) return Number(t);
    if (t.startsWith('"') && !t.includes("${")) return JSON.parse(t);
    throw new Failure("pins.nix must contain literal data only", 2);
  };
  const result = value();
  if (pos !== tokens.length || result?.schemaVersion !== 1)
    throw new Failure("unsupported pins schema", 2);
  return result;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function edit_pins(text, updates) {
  const old = parse_pins(text);
  for (const [name, fields] of Object.entries(updates)) {
    if (!Object.hasOwn(old.repositories, name))
      throw new Failure("unknown pin: " + name, 2);
    const block = new RegExp(
      "(^[ \\t]*" + escape(name) + "\\s*=\\s*\\{)([^{}]*)(\\})",
      "gm",
    );
    const matches = [...text.matchAll(block)];
    if (matches.length !== 1)
      throw new Failure(
        "pin entry must use a literal attribute block: " + name,
        2,
      );
    const m = matches[0];
    let body = m[2];
    for (const [field, val] of Object.entries(fields)) {
      const p = new RegExp(
        "(\\b" +
          escape(field) +
          '\\s*=\\s*)(?:"(?:\\\\.|[^"\\\\])*"|null)(\\s*;)',
        "g",
      );
      const count = [...body.matchAll(p)].length;
      if (!count && field === "sourceUrl") {
        body += "\n      sourceUrl = " + JSON.stringify(val) + ";\n    ";
        continue;
      }
      if (count !== 1)
        throw new Failure("missing/ambiguous pin field: " + field, 2);
      body = body.replace(p, (_, a, b) => a + JSON.stringify(val) + b);
    }
    text =
      text.slice(0, m.index + m[1].length) +
      body +
      text.slice(m.index + m[1].length + m[2].length);
  }
  const parsed = parse_pins(text);
  for (const [n, f] of Object.entries(updates))
    for (const [k, v] of Object.entries(f))
      if (!equal(parsed.repositories[n][k], v))
        throw new Failure("pin serialization verification failed");
  return text;
}
export const valid_sha = (v) =>
  typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
export const valid_ref = (v) =>
  typeof v === "string" &&
  v.startsWith("refs/heads/") &&
  !run([env.WB_REAL_GIT, "check-ref-format", v], { check: false }).returncode;
// Match the legacy identity serialization so old host/guest protocol snapshots
// remain comparable across the runtime migration.
export function sortedJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(sortedJSON).join(", ") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => sortedJSON(k) + ": " + sortedJSON(value[k]))
        .join(", ") +
      "}"
    );
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
