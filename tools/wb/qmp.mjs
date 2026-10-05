import net from "node:net";
import readline from "node:readline";
import { Failure } from "./common.mjs";
export async function qmp(socketPath, requests, timeout = 15000) {
  const client = net.createConnection(socketPath),
    lines = readline.createInterface({ input: client }),
    iterator = lines[Symbol.asyncIterator]();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    client.destroy(new Error("QMP timeout"));
  }, timeout);
  // readline's iterator does not forward input errors reliably; race every read.
  const failed = new Promise((_, reject) => {
    client.on("error", reject);
    client.on("close", () =>
      reject(new Error(expired ? "QMP timeout" : "QMP disconnected")),
    );
  });
  failed.catch(() => {});
  const next = async () => {
    const r = await Promise.race([iterator.next(), failed]);
    if (r.done) throw new Error("QMP disconnected");
    return JSON.parse(r.value);
  };
  try {
    const greeting = await next(),
      responses = [];
    for (const [i, request] of [
      { execute: "qmp_capabilities" },
      ...requests,
    ].entries()) {
      client.write(JSON.stringify({ ...request, id: i }) + "\n");
      let found = false;
      for (let count = 0; count < 100; count++) {
        const reply = await next();
        if (reply.id !== i) continue;
        if (reply.error)
          throw new Failure("QMP observation failed", 76, { response: reply });
        responses.push(reply.return);
        found = true;
        break;
      }
      if (!found) throw new Failure("QMP observation exceeded event bound", 76);
    }
    return { greeting, responses: responses.slice(1) };
  } finally {
    clearTimeout(timer);
    lines.close();
    client.destroy();
  }
}
