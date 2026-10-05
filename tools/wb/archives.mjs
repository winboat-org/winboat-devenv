import yauzl from "yauzl";
import yazl from "yazl";
import { pipeline } from "node:stream/promises";
import {
  fs,
  path,
  Failure,
  digest,
  identity,
  symlink,
  file,
  mkdir,
  exists,
} from "./common.mjs";
export async function create_zip(archive, files) {
  const zip = new yazl.ZipFile(),
    output = fs.createWriteStream(archive, { flags: "wx" });
  const done = pipeline(zip.outputStream, output);
  zip.on("error", (e) => output.destroy(e));
  try {
    for (const [source, relative] of files) {
      const stat = fs.statSync(source);
      zip.addFile(source, relative, {
        compressionLevel: 1,
        mtime: new Date(
          Math.max(new Date("1980-01-01T00:00:00Z").getTime(), stat.mtimeMs),
        ),
        mode: stat.mode,
      });
    }
    zip.end();
    await done;
  } catch (e) {
    output.destroy();
    await done.catch(() => {});
    throw e;
  }
}
export function windows_relative(value) {
  if (typeof value !== "string")
    throw new Failure("unsafe Windows source path", 2);
  value = value.replaceAll("\\", "/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw new Failure("unsafe Windows source path", 2);
  const parts = value.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.includes(".."))
    throw new Failure("unsafe Windows source path", 2);
  for (const part of parts)
    if (
      /[. ]$/.test(part) ||
      /[:<>"|?*\r\n\0]/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    )
      throw new Failure("source path has Windows alias/device semantics", 2, {
        path: value,
      });
  return parts.join("/");
}
export async function extract_artifact(archive, destination, files) {
  const table = new Map();
  for (const f of files) {
    const relative = windows_relative(f.path),
      key = relative.toLowerCase();
    if (table.has(key))
      throw new Failure("case-aliased artifact file table", 74);
    table.set(key, f);
  }
  let zip;
  try {
    zip = await new Promise((resolve, reject) =>
      yauzl.open(archive, { lazyEntries: true, autoClose: false }, (e, z) =>
        e ? reject(e) : resolve(z),
      ),
    );
    const members = await new Promise((resolve, reject) => {
      const result = [],
        seen = new Set();
      zip.on("error", reject);
      zip.on("end", () => {
        if (seen.size !== table.size)
          reject(new Failure("artifact archive omitted required files", 74));
        else resolve(result);
      });
      zip.on("entry", (member) => {
        try {
          const relative = windows_relative(member.fileName),
            key = relative.toLowerCase();
          if (((member.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
            throw new Failure("artifact archive contains a symlink", 74);
          if (member.fileName.replaceAll("\\", "/").endsWith("/")) {
            if (member.uncompressedSize || table.has(key))
              throw new Failure(
                "artifact archive contains an invalid directory entry",
                74,
              );
            zip.readEntry();
            return;
          }
          if (seen.has(key) || !table.has(key))
            throw new Failure(
              "artifact archive member differs from its file table",
              74,
            );
          const f = table.get(key);
          if (relative !== f.path || member.uncompressedSize !== f.size)
            throw new Failure(
              "artifact archive path/size differs from its file table",
              74,
            );
          seen.add(key);
          result.push(member);
          zip.readEntry();
        } catch (e) {
          reject(e);
        }
      });
      zip.readEntry();
    });
    for (const member of members) {
      const f = table.get(windows_relative(member.fileName).toLowerCase()),
        p = path.join(destination, f.path);
      let ancestor = p;
      for (;;) {
        ancestor = path.dirname(ancestor);
        if (symlink(ancestor))
          throw new Failure(
            "artifact collection encountered a directory symlink",
            74,
          );
        if (path.dirname(ancestor) === ancestor) break;
      }
      const matches = () =>
        !symlink(p) &&
        file(p) &&
        digest(p) === f.sha256 &&
        fs.statSync(p).size === f.size;
      if (exists(p) || symlink(p)) {
        if (!matches())
          throw new Failure(
            "artifact collection refuses a divergent existing file",
            74,
          );
        continue;
      }
      mkdir(path.dirname(p));
      const partial = path.join(
          path.dirname(destination),
          "artifact.partial-" + identity(),
        ),
        stream = await new Promise((resolve, reject) =>
          zip.openReadStream(member, (e, s) => (e ? reject(e) : resolve(s))),
        );
      await pipeline(
        stream,
        fs.createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      if (digest(partial) !== f.sha256 || fs.statSync(partial).size !== f.size)
        throw new Failure(
          "artifact archive content mismatch; partial file retained",
          74,
        );
      try {
        fs.linkSync(partial, p);
      } catch (e) {
        if (e.code !== "EEXIST" || !matches())
          throw new Failure(
            "artifact collection refuses a concurrent divergent file",
            74,
          );
      }
      fs.unlinkSync(partial);
    }
  } catch (e) {
    if (e instanceof Failure) throw e;
    throw new Failure("invalid artifact archive: " + e.message, 74);
  } finally {
    zip?.close();
  }
}
