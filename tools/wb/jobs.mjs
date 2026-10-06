import {
  fs,
  path,
  env,
  Failure,
  identity,
  locked,
  write_json,
  readJSON,
  now,
  spawn,
  exists,
  sleep,
  hash,
} from "./common.mjs";
import { page } from "./evidence.mjs";
export function job_path(ws, id) {
  if (typeof id !== "string" || !/^op-[0-9a-f]{32}$/.test(id))
    throw new Failure("invalid job ID", 2);
  return path.join(ws.state, "jobs", id + ".json");
}
const cli = new URL("./cli.mjs", import.meta.url).pathname;
function detached(argv, logPath) {
  const log = fs.openSync(logPath, "a"),
    child = spawn(env.WB_NODE || process.execPath, [cli, ...argv], {
      detached: true,
      stdio: ["ignore", log, log],
    });
  fs.closeSync(log);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child);
    });
  });
}
export async function start(ws, argv, requestId) {
  if (requestId != null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId))
      throw new Failure("request ID must be 1..128 simple characters", 2);
    const key = hash(requestId),
      request = path.join(ws.state, "jobs/requests", key + ".json");
    return locked(
      path.join(ws.state, "locks", "request-" + key + ".lock"),
      async () => {
        const fingerprint = hash(
          JSON.stringify({
            argv,
            workspace: ws.root,
            paths: env.WB_INVOCATION_PATHS ?? null,
          }),
        );
        if (exists(request)) {
          const saved = readJSON(request);
          if (saved.fingerprint !== fingerprint)
            throw new Failure(
              "request ID already belongs to different arguments",
              2,
            );
          const receipt = status(ws, saved.jobId);
          return {
            jobId: saved.jobId,
            state: receipt.state,
            receipt: job_path(ws, saved.jobId),
            reused: true,
          };
        }
        // The mapping is durable before the runner is spawned, closing the client-disconnect retry window.
        return launch(ws, argv, { path: request, fingerprint });
      },
    );
  }
  return launch(ws, argv);
}
async function launch(ws, argv, request) {
  const jobId = identity(),
    p = job_path(ws, jobId),
    directory = path.join(ws.state, "jobs", jobId);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    jobId,
    state: "queued",
    arguments: argv,
    workspace: ws.root,
    log: path.join(directory, "stderr.log"),
    result: path.join(directory, "result.json"),
    created: now(),
  };
  write_json(p, receipt);
  if (request)
    write_json(request.path, { fingerprint: request.fingerprint, jobId });
  try {
    await detached(
      ["--workspace", ws.root, "job", "run", "--id", jobId],
      path.join(directory, "runner.log"),
    );
  } catch (e) {
    Object.assign(receipt, { state: "failed", error: e.message });
    write_json(p, receipt);
    throw e;
  }
  return { jobId, state: "queued", receipt: p };
}
export function status(ws, id) {
  const receipt = readJSON(job_path(ws, id));
  if (receipt.state === "running")
    try {
      process.kill(receipt.pid, 0);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
      Object.assign(receipt, {
        state: "interrupted",
        externalStep:
          "resume explicitly; push receipts must be reconciled before retrying publication",
      });
      write_json(job_path(ws, id), receipt);
    }
  const native = receipt.operation?.exitCode;
  if (
    ["succeeded", "failed", "reboot-required"].includes(receipt.state) &&
    Number.isInteger(native)
  ) {
    // Older runners retain the Unix status alongside their full Windows receipt.
    // Normalize the observed view without rewriting historical evidence.
    return {
      ...receipt,
      processExitCode: receipt.processExitCode ?? receipt.exitCode,
      exitCode: native || receipt.exitCode,
      ...(native === 3010 || native === 1641
        ? { state: "reboot-required" }
        : {}),
    };
  }
  return receipt;
}
export async function wait(ws, id, timeout = 45) {
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 50)
    throw new Failure("wait timeout must be 0..50 seconds", 2);
  const deadline = Date.now() + timeout * 1000;
  let receipt;
  do {
    receipt = status(ws, id);
    if (!["queued", "running"].includes(receipt.state))
      return { ...receipt, terminal: true, timedOut: false };
    if (Date.now() >= deadline) break;
    await sleep(Math.min(250, deadline - Date.now()));
  } while (true);
  return {
    ...receipt,
    terminal: false,
    timedOut: true,
    externalStep:
      "Wait again using this same durable job ID; timeout does not cancel or restart it.",
  };
}
export function logs(ws, id, offset, limit) {
  const receipt = readJSON(job_path(ws, id));
  const expected = path.join(ws.state, "jobs", id, "stderr.log");
  if (receipt.log !== expected)
    throw new Failure("job log path differs from its owned directory", 2);
  return { jobId: id, ...page(expected, offset, limit) };
}
export async function execute(ws, id) {
  const p = job_path(ws, id);
  let receipt = readJSON(p),
    child,
    log,
    result;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    Object.assign(receipt, { state: "cancelled", exitCode: 130 });
    write_json(p, receipt);
  };
  try {
    const completion = await locked(
      path.join(ws.state, "locks", id + ".lock"),
      async () => {
        receipt = readJSON(p);
        if (receipt.state === "cancelled") return null;
        if (receipt.state !== "queued")
          throw new Failure("job is already running or finished", 2);
        // Claim the queued job before touching its durable output. A duplicate
        // runner must not truncate an active or completed worker's receipt.
        log = fs.openSync(receipt.log, "a");
        result = fs.openSync(receipt.result, "w");
        child = spawn(
          env.WB_NODE || process.execPath,
          [cli, "--workspace", ws.root, "--json", ...receipt.arguments],
          { stdio: ["ignore", result, log], detached: true },
        );
        const closed = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) =>
            resolve(code ?? (signal ? 128 : 1)),
          );
        });
        // Return an object so the lock covers claiming the job, not its lifetime.
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        process.on("SIGTERM", cancel);
        Object.assign(receipt, {
          state: "running",
          pid: process.pid,
          workerPid: child.pid,
        });
        write_json(p, receipt);
        return { closed };
      },
    );
    if (!completion) return receipt;
    const code = await completion.closed;
    if (cancelled) return receipt;
    Object.assign(receipt, {
      state: code === 0 ? "succeeded" : "failed",
      exitCode: code,
      finished: now(),
    });
    try {
      receipt.operation = readJSON(receipt.result);
      const native = receipt.operation.exitCode;
      if (!Number.isInteger(native))
        throw new Error("missing operation exit code");
      receipt.processExitCode = code;
      receipt.exitCode = native || code;
      if (native === 3010 || native === 1641) receipt.state = "reboot-required";
      else if (native !== 0 || code !== 0) receipt.state = "failed";
    } catch {
      Object.assign(receipt, {
        state: "failed",
        exitCode: code || 1,
        error: "worker returned no valid JSON receipt",
      });
    }
    write_json(p, receipt);
    return receipt;
  } finally {
    process.off("SIGTERM", cancel);
    if (log !== undefined) fs.closeSync(log);
    if (result !== undefined) fs.closeSync(result);
  }
}
export async function cancel(ws, id) {
  return locked(path.join(ws.state, "locks", id + ".lock"), () => {
    const receipt = status(ws, id);
    if (receipt.state === "queued") {
      Object.assign(receipt, { state: "cancelled", exitCode: 130 });
      write_json(job_path(ws, id), receipt);
    } else if (receipt.state === "running") {
      process.kill(receipt.pid, "SIGTERM");
      return { jobId: id, state: "cancelling" };
    }
    return receipt;
  });
}
export async function resume(ws, id) {
  const receipt = status(ws, id);
  if (receipt.state === "queued") {
    // Recover the narrow interruption window between publishing a queued job
    // and spawning its runner. The runner's claim lock rejects any duplicate.
    await detached(
      ["--workspace", ws.root, "job", "run", "--id", id],
      path.join(ws.state, "jobs", id, "runner.log"),
    );
    return {
      jobId: id,
      state: "queued",
      receipt: job_path(ws, id),
      reused: true,
    };
  }
  if (!["interrupted", "failed", "cancelled"].includes(receipt.state))
    throw new Failure(
      "only interrupted/failed/cancelled jobs can be resumed",
      2,
    );
  if (receipt.arguments[0] === "repo" && receipt.arguments[1] === "push")
    throw new Failure(
      "publication requires wb repo reconcile before any new push",
      2,
    );
  return start(ws, receipt.arguments);
}
