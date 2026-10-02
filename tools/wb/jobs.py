import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from .common import Failure, identity, locked, write_json


def job_path(ws, job_id):
    if not job_id.startswith("op-") or len(job_id) != 35 or any(c not in "0123456789abcdef" for c in job_id[3:]):
        raise Failure("invalid job ID", 2)
    return ws.state / "jobs" / (job_id + ".json")


def start(ws, argv):
    job_id = identity()
    path = job_path(ws, job_id)
    directory = ws.state / "jobs" / job_id
    directory.mkdir(parents=True)
    receipt = {"schemaVersion": 1, "jobId": job_id, "state": "queued", "arguments": argv,
               "workspace": str(ws.root), "log": str(directory / "stderr.log"),
               "result": str(directory / "result.json"), "created": time.time()}
    write_json(path, receipt)
    with (directory / "runner.log").open("a") as log:
        proc = subprocess.Popen([sys.executable, "-m", "wb", "--workspace", str(ws.root),
                                 "job", "run", "--id", job_id], stdin=subprocess.DEVNULL,
                                stdout=log, stderr=log, start_new_session=True)
    return {"jobId": job_id, "state": "queued", "receipt": str(path)}


def status(ws, job_id):
    receipt = json.loads(job_path(ws, job_id).read_text())
    if receipt["state"] == "running":
        try:
            os.kill(receipt["pid"], 0)
        except ProcessLookupError:
            receipt.update(state="interrupted", externalStep="resume explicitly; push receipts must be reconciled before retrying publication")
            write_json(job_path(ws, job_id), receipt)
    return receipt


def execute(ws, job_id):
    path = job_path(ws, job_id)
    receipt = json.loads(path.read_text())
    directory = Path(receipt["log"]).parent
    with Path(receipt["log"]).open("a") as log, Path(receipt["result"]).open("w") as result:
        # Cancellation terminates the worker too, leaving its atomic transaction
        # journal for reconciliation; disconnect never signals this process.
        def cancel(signum, frame):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            # Popen.wait holds a non-reentrant lock. Calling wait again from
            # its signal handler deadlocks; record cancellation and unwind.
            receipt.update(state="cancelled", exitCode=130)
            write_json(path, receipt)
            raise SystemExit(130)
        with locked(ws.state / "locks" / (job_id + ".lock")):
            receipt = json.loads(path.read_text())
            if receipt["state"] == "cancelled":
                return receipt
            if receipt["state"] != "queued":
                raise Failure("job is already running or finished", 2)
            proc = subprocess.Popen([sys.executable, "-m", "wb", "--workspace", str(ws.root), "--json", *receipt["arguments"]],
                                    stdout=result, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
            signal.signal(signal.SIGTERM, cancel)
            receipt.update(state="running", pid=os.getpid(), workerPid=proc.pid)
            write_json(path, receipt)
        code = proc.wait()
    receipt.update(state="succeeded" if code == 0 else "failed", exitCode=code, finished=time.time())
    try:
        receipt["operation"] = json.loads(Path(receipt["result"]).read_text())
    except (OSError, ValueError):
        receipt.update(state="failed", error="worker returned no valid JSON receipt")
    write_json(path, receipt)
    return receipt


def cancel(ws, job_id):
    with locked(ws.state / "locks" / (job_id + ".lock")):
        receipt = status(ws, job_id)
        if receipt["state"] == "queued":
            receipt.update(state="cancelled", exitCode=130)
            write_json(job_path(ws, job_id), receipt)
        elif receipt["state"] == "running":
            os.kill(receipt["pid"], signal.SIGTERM)
            return {"jobId": job_id, "state": "cancelling"}
    return receipt


def resume(ws, job_id):
    receipt = status(ws, job_id)
    if receipt["state"] not in {"interrupted", "failed", "cancelled"}:
        raise Failure("only interrupted/failed/cancelled jobs can be resumed", 2)
    if receipt["arguments"][:2] == ["repo", "push"]:
        raise Failure("publication requires wb repo reconcile before any new push", 2)
    return start(ws, receipt["arguments"])
