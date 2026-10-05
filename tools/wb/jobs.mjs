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
} from "./common.mjs";
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
export async function start(ws, argv) {
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
  return receipt;
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
    } catch {
      Object.assign(receipt, {
        state: "failed",
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
