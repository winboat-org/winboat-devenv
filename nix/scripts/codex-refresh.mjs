// Publish a fresh locked shell before Codex starts a command.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
export function refresh(root, devenv) {
  const ambient = { ...process.env };
  delete ambient.BASH_ENV;
  const result = spawnSync(devenv, ["--quiet", "direnv-export"], {
    cwd: root,
    env: ambient,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  const content = result.stdout;
  if (!content.toString().trim())
    throw new Error("devenv returned an empty environment");
  const state = path.join(root, ".devenv", "codex");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const generation = crypto.createHash("sha256").update(content).digest("hex"),
    tmp = path.join(state, crypto.randomUUID());
  try {
    fs.writeFileSync(
      tmp,
      Buffer.concat([Buffer.from("# " + generation + "\n"), content]),
      { flag: "wx", mode: 0o600 },
    );
    fs.renameSync(tmp, path.join(state, "current"));
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    refresh(...process.argv.slice(2));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Locked devenv refresh failed: " + error.message,
        },
      }) + "\n",
    );
  }
}
