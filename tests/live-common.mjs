import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { Failure, fs, path, write_json } from "../tools/wb/common.mjs";
export function arguments_(extra = {}) {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      "state-root": { type: "string" },
      ...extra,
    },
  });
  for (const name of ["name", "state-root"])
    if (!values[name]) throw new Failure("--" + name + " is required", 2);
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k.replaceAll("-", "_"), v]),
  );
}
export function command(argv, timeout = 900000) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1).map(String), {
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(timeout),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
export class Client {
  constructor(root, state, command_) {
    this.prefix = [command_, "--workspace", root, "--state-root", state];
    this.id = 0;
    this.pending = new Map();
  }
  async rpc(method, params) {
    if (!this.child) {
      this.child = spawn(this.prefix[0], [...this.prefix.slice(1), "mcp"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", (line) => {
        const value = JSON.parse(line),
          request = this.pending.get(value.id);
        if (request) {
          this.pending.delete(value.id);
          request.resolve(value);
        }
      });
      const fail = (error) => {
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
      };
      this.child.on("error", fail);
      this.child.on("close", () => {
        lines.close();
        fail(new Error("MCP disconnected"));
      });
      await this.rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "windows-acceptance", version: "1" },
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.id,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("MCP response timed out"));
        }, 900000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  async close() {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.child.kill();
      await once(this.child, "close");
    }
  }
}
export function output(summary) {
  process.stdout.write(JSON.stringify(summary) + "\n");
}
