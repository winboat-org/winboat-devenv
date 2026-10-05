import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { edit_pins, parse_pins, digest, sleep } from "../tools/wb/common.mjs";
export { assert, fs, path, parse_pins, edit_pins, digest, sleep };
export const ROOT =
  process.env.WB_TEST_SOURCE || path.resolve(import.meta.dirname, "..");
export const WB = process.env.WB_TEST_COMMAND;
export const WRAPPER = process.env.WB_TEST_GIT;
export const REAL = process.env.WB_REAL_GIT;
export const MANIFEST = JSON.parse(
  fs.readFileSync(process.env.WB_MANIFEST_FILE, "utf8"),
);
export function call(argv, options = {}) {
  const result = spawnSync(String(argv[0]), argv.slice(1).map(String), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  if (options.check !== false)
    assert.equal(
      result.status,
      0,
      argv.join(" ") + "\n" + result.stdout + result.stderr,
    );
  return { ...result, returncode: result.status };
}
export function asyncCall(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(String(argv[0]), argv.slice(1).map(String), options);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.once("error", reject);
    child.once("close", (status) => {
      if (options.check !== false && status) reject(new Error(stdout + stderr));
      else resolve({ status, stdout, stderr });
    });
  });
}
export function write(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value);
}
export function temporary(t, prefix = "wb acceptance spaces ") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
export class Fixture {
  constructor(t) {
    this.base = temporary(t);
    this.root = path.join(this.base, "workspace with spaces");
    fs.mkdirSync(this.root);
    this.env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
      WB_WORKSPACE_ROOT: this.root,
    };
    this.urls = {};
    this.shas = {};
    this.upstream = path.join(this.base, "upstream");
    fs.mkdirSync(this.upstream);
    const [, thirdURL, thirdSHA] = this.makeSource("third-party");
    const [shader, shaderURL] = this.makeSource("shader-container");
    write(
      path.join(shader, ".gitmodules"),
      '[submodule "headers"]\n\tpath = submodules/spirv_headers\n\turl = ' +
        thirdURL +
        "\n",
    );
    this.g(
      shader,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      thirdSHA,
      "submodules/spirv_headers",
    );
    this.g(shader, "add", ".gitmodules");
    this.g(shader, "commit", "-m", "nested shader headers");
    const shaderSHA = this.head(shader);
    this.g(shader, "push", shaderURL, "HEAD:dev");
    const names = Object.keys(MANIFEST.repositories).sort(
      (a, b) =>
        MANIFEST.repositories[b].path.split("/").length -
        MANIFEST.repositories[a].path.split("/").length,
    );
    for (const name of names) {
      const repo = MANIFEST.repositories[name],
        work = path.join(this.base, "source " + name);
      fs.mkdirSync(work);
      this.g(work, "init", "-b", "dev");
      write(path.join(work, "source.txt"), name + "\n");
      write(path.join(work, "other.txt"), "original\n");
      const children = Object.fromEntries(
        Object.entries(MANIFEST.repositories)
          .filter(([, r]) => r.parent === name)
          .map(([n, r]) => [r.submodulePath, n]),
      );
      const paths = [...repo.submodules.paths];
      if (name === "qemu-helios") paths.push("forbidden-qemu-module");
      if (name === "helios") paths.push("LookingGlass");
      let modules = "";
      paths.forEach((p, i) => {
        const child = children[p];
        let url = child ? this.urls[child] : thirdURL,
          sha = child ? this.shas[child] : thirdSHA;
        if (
          ["dxvk", "dxil-spirv"].includes(name) &&
          p === "subprojects/dxbc-spirv"
        ) {
          url = shaderURL;
          sha = shaderSHA;
        }
        modules +=
          '[submodule "m' + i + '"]\n\tpath = ' + p + "\n\turl = " + url + "\n";
        this.g(work, "update-index", "--add", "--cacheinfo", "160000", sha, p);
      });
      if (modules) {
        write(path.join(work, ".gitmodules"), modules);
        this.g(work, "add", ".gitmodules");
      }
      this.g(work, "add", "source.txt", "other.txt");
      this.g(work, "commit", "-m", "fixture " + name);
      this.shas[name] = this.head(work);
      this.urls[name] = path.join(this.upstream, name + ".git");
      call([REAL, "clone", "--bare", work, this.urls[name]], { env: this.env });
    }
    for (const relative of [
      "config/defaults.json",
      ".gitignore",
      "devenv.lock",
    ])
      write(
        path.join(this.root, relative),
        fs.readFileSync(path.join(ROOT, relative)),
      );
    write(path.join(this.root, "devenv.nix"), "{ ... }: {}\n");
    write(path.join(this.root, "nix/repositories.nix"), "{}\n");
    this.pins = path.join(this.root, "nix/pins.nix");
    write(
      this.pins,
      edit_pins(
        fs.readFileSync(path.join(ROOT, "nix/pins.nix"), "utf8"),
        Object.fromEntries(
          Object.entries(this.shas).map(([n, rev]) => [
            n,
            { rev, ref: "refs/heads/dev" },
          ]),
        ),
      ),
    );
    this.local = { schemaVersion: 1, workspace: { remotes: { ...this.urls } } };
    this.writeLocal();
    write(path.join(this.root, "unrelated.txt"), "original\n");
    this.g(this.root, "init", "-b", "workspace");
    this.g(
      this.root,
      "add",
      "config/defaults.json",
      ".gitignore",
      "devenv.lock",
      "devenv.nix",
      "nix/pins.nix",
      "nix/repositories.nix",
      "unrelated.txt",
    );
    this.g(this.root, "commit", "-m", "workspace fixture");
  }
  g(p, ...args) {
    const options = typeof args.at(-1) === "object" ? args.pop() : {};
    return call([REAL, "-C", p, ...args], { env: this.env, ...options });
  }
  head(p) {
    return this.g(p, "rev-parse", "HEAD").stdout.trim();
  }
  makeSource(name) {
    const work = path.join(this.base, "source " + name),
      remote = path.join(this.upstream, name + ".git");
    fs.mkdirSync(work);
    this.g(work, "init", "-b", "dev");
    write(path.join(work, "file.txt"), name);
    this.g(work, "add", "file.txt");
    this.g(work, "commit", "-m", name);
    call([REAL, "clone", "--bare", work, remote], { env: this.env });
    return [work, remote, this.head(work)];
  }
  writeLocal() {
    write(path.join(this.root, "local.json"), JSON.stringify(this.local));
  }
  wb(...args) {
    const options = typeof args.at(-1) === "object" ? args.pop() : {};
    const result = call([WB, "--workspace", this.root, "--json", ...args], {
      env: { ...this.env, ...options.extra },
      check: options.check,
    });
    const value = JSON.parse(result.stdout);
    return options.check === false ? value : value.result;
  }
  wrapper(...args) {
    const options = typeof args.at(-1) === "object" ? args.pop() : {};
    return call([WRAPPER, ...args], {
      cwd: options.cwd || this.root,
      env: { ...this.env, ...options.extra },
      check: options.check,
      input: options.input,
    });
  }
  path(n) {
    return path.join(this.root, MANIFEST.repositories[n].path);
  }
  snapshot(p) {
    return [
      "status --porcelain=v1",
      "diff --binary",
      "diff --cached --binary",
      "ls-files --stage",
    ].map((command) => this.g(p, ...command.split(" ")).stdout);
  }
  develop(n = "winboat") {
    this.wb("repo", "sync", "--repo", n);
    const p = this.path(n);
    this.g(p, "switch", "-c", "dev");
    this.change(p, "changed\n");
    return [p, this.head(p)];
  }
  change(p, value) {
    write(path.join(p, "source.txt"), value);
    this.g(p, "add", "source.txt");
    this.g(p, "commit", "-m", "development");
  }
  pinValues(text = fs.readFileSync(this.pins, "utf8")) {
    return parse_pins(text).repositories;
  }
  receipts() {
    return fs
      .readdirSync(path.join(this.root, ".state/operations"))
      .filter((n) => n.endsWith(".json"))
      .map((n) =>
        JSON.parse(
          fs.readFileSync(path.join(this.root, ".state/operations", n)),
        ),
      );
  }
}
export async function until(callback, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = callback();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, "Timed out: " + JSON.stringify(value));
    await sleep(20);
  }
}
export function mcp(t, f) {
  const child = spawn(WB, ["--workspace", f.root, "mcp"], {
    env: f.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0,
    diagnostic = "";
  const pending = new Map();
  child.stderr.on("data", (b) => (diagnostic += b));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line),
      request = pending.get(value.id);
    if (request) {
      pending.delete(value.id);
      request.resolve(value);
    }
  });
  child.on("error", (e) => {
    for (const request of pending.values()) request.reject(e);
  });
  child.on("close", () => {
    for (const request of pending.values())
      request.reject(new Error("MCP exited: " + diagnostic));
  });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "close");
    }
  });
  return {
    child,
    rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const current = ++id,
          timer = setTimeout(() => {
            pending.delete(current);
            reject(new Error("MCP response timeout: " + diagnostic));
          }, 30000);
        pending.set(current, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) +
            "\n",
        );
      });
    },
  };
}
