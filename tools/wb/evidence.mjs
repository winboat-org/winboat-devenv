import { fs, path, Failure, write_json, exists, symlink } from "./common.mjs";

export function compact(ws, payload) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) <= 16000) return payload;
  write_json(
    path.join(ws.state, "mcp-results", payload.operationId + ".json"),
    payload,
  );
  const result = payload.result ?? {};
  const fields = [
    "jobId",
    "state",
    "exitCode",
    "terminal",
    "timedOut",
    "receipt",
    "manifest",
    "artifact",
    "externalStep",
    "error",
  ];
  const summary = Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(result, key))
      .map((key) => [
        key,
        typeof result[key] === "string"
          ? result[key].slice(0, 2000)
          : ["string", "number", "boolean"].includes(typeof result[key])
            ? result[key]
            : "see retained evidence",
      ]),
  );
  return {
    schemaVersion: payload.schemaVersion,
    operationId: payload.operationId,
    state: payload.state,
    exitCode: payload.exitCode,
    evidencePaths: payload.evidencePaths,
    ...(payload.error ? { error: payload.error.slice(0, 2000) } : {}),
    result: summary,
    truncated: true,
    fullResult: {
      id: payload.operationId,
      bytes: Buffer.byteLength(serialized),
      readTool: "evidence_read",
    },
  };
}

// Only retained MCP receipts and job logs are addressable, never arbitrary paths.
export function page(file, offset = 0, limit = 8192) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16384
  )
    throw new Failure(
      "offset must be nonnegative; limit must be 1..16384 bytes",
      2,
    );
  if (!exists(file))
    throw new Failure("evidence file is unavailable", 2, { path: file });
  if (symlink(file)) throw new Failure("refusing symlinked evidence", 2);
  const fd = fs.openSync(file, "r");
  try {
    const totalBytes = fs.fstatSync(fd).size;
    if (offset > totalBytes)
      throw new Failure("offset exceeds evidence size", 2);
    const buffer = Buffer.alloc(limit);
    const bytes = fs.readSync(fd, buffer, 0, limit, offset);
    return {
      path: file,
      offset,
      bytes,
      totalBytes,
      nextOffset: offset + bytes,
      eof: offset + bytes >= totalBytes,
      encoding: "utf8",
      content: buffer.subarray(0, bytes).toString("utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}
export function read(ws, id, offset, limit) {
  if (!/^op-[0-9a-f]{32}$/.test(id))
    throw new Failure("invalid evidence ID", 2);
  return page(path.join(ws.state, "mcp-results", id + ".json"), offset, limit);
}
