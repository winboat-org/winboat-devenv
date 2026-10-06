import yauzl from "yauzl";
import { hash, Failure } from "./common.mjs";
export async function read_metadata(archive, name) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true }, (e, z) =>
      e ? reject(e) : resolve(z),
    ),
  );
  return new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () =>
      reject(new Failure("missing artifact metadata: " + name, 74)),
    );
    zip.on("entry", (entry) => {
      if (entry.fileName !== name) {
        zip.readEntry();
        return;
      }
      if (
        entry.uncompressedSize > 16 * 1024 * 1024 ||
        !entry.uncompressedSize
      ) {
        zip.close();
        reject(new Failure("artifact metadata too large", 74));
        return;
      }
      zip.openReadStream(entry, (e, stream) => {
        if (e) {
          zip.close();
          reject(e);
          return;
        }
        let size = 0;
        const chunks = [];
        stream.on("error", reject);
        stream.on("data", (b) => {
          size += b.length;
          if (size > 16 * 1024 * 1024) {
            stream.destroy(new Failure("artifact metadata exceeds limit", 74));
            return;
          }
          chunks.push(b);
        });
        stream.on("end", () => {
          zip.close();
          const bytes = Buffer.concat(chunks);
          try {
            resolve({
              value: JSON.parse(bytes.toString("utf8")),
              record: { path: name, sha256: hash(bytes), size: bytes.length },
            });
          } catch (error) {
            reject(error);
          }
        });
      });
    });
    zip.readEntry();
  });
}
