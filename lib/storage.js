// Where requests, documents and the stamp are kept:
// - "fs": on disk in DATA_DIR, for a normal Node.js server
// - "blob": EdgeOne Pages Blob storage, when running as an EdgeOne Node Function
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Bundlers can drop __dirname, so fall back to the working directory (the project root).
const ROOT = typeof __dirname === "string" ? path.resolve(__dirname, "..") : process.cwd();
const BLOB_STORE = "hl-attestations";
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function checkKey(key) {
  if (!KEY_RE.test(key) || key.includes("..")) throw new Error(`Invalid storage key: ${key}`);
}

function fsDriver() {
  const dir = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
  const full = (key) => (checkKey(key), path.join(dir, ...key.split("/")));
  const signingKey = crypto.randomBytes(32);
  const sign = (key, exp) => crypto.createHmac("sha256", signingKey).update(`${key}.${exp}`).digest("base64url");

  async function walk(folder, prefix, out) {
    let entries;
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return out;
      throw err;
    }
    for (const entry of entries) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), key, out);
      else if (!entry.name.endsWith(".tmp")) out.push(key);
    }
    return out;
  }

  return {
    name: "fs",
    dir,
    async getBytes(key) {
      try {
        return await fs.promises.readFile(full(key));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async putBytes(key, buf, { onlyIfNew = false } = {}) {
      const file = full(key);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      if (onlyIfNew) {
        try {
          await fs.promises.writeFile(file, buf, { flag: "wx" });
          return true;
        } catch (err) {
          if (err.code === "EEXIST") return false;
          throw err;
        }
      }
      const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
      return true;
    },
    async delete(key) {
      const file = full(key);
      await fs.promises.rm(file, { force: true });
      await fs.promises.rmdir(path.dirname(file)).catch(() => {}); // only succeeds when the folder is empty
    },
    async list(prefix) {
      const base = prefix.slice(0, prefix.lastIndexOf("/") + 1).replace(/\/$/, "");
      const keys = await walk(base ? full(base) : dir, base, []);
      return keys.filter((k) => k.startsWith(prefix));
    },
    // The browser PUTs the file to this server; the signature limits it to one key for a short time.
    async createUploadUrl(key, { expireSeconds = 1800 } = {}) {
      checkKey(key);
      const exp = Math.floor(Date.now() / 1000) + expireSeconds;
      const query = new URLSearchParams({ key, exp: String(exp), sig: sign(key, exp) });
      return { url: `/api/uploads/local?${query}`, method: "PUT", headers: { "Content-Type": "application/octet-stream" } };
    },
    verifyUpload({ key, exp, sig }) {
      if (typeof key !== "string" || typeof sig !== "string" || !(Number(exp) > Date.now() / 1000)) return false;
      const expected = sign(key, Number(exp));
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    },
  };
}

function blobDriver() {
  const blob = require("@edgeone/pages-blob");
  let store = null;
  // Created on first use: outside EdgeOne the SDK throws, and the error should reach the request.
  const s = () => store || (store = blob.getStore({ name: BLOB_STORE, consistency: "strong" }));
  const arrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  return {
    name: "blob",
    async getBytes(key) {
      checkKey(key);
      const data = await s().get(key, { type: "arrayBuffer" });
      return data ? Buffer.from(data) : null;
    },
    async putBytes(key, buf, { onlyIfNew = false } = {}) {
      checkKey(key);
      try {
        await s().set(key, arrayBuffer(buf), onlyIfNew ? { onlyIfNew: true } : undefined);
        return true;
      } catch (err) {
        if (onlyIfNew && err instanceof blob.PreconditionFailedError) return false;
        throw err;
      }
    },
    async delete(key) {
      checkKey(key);
      await s().delete(key);
    },
    async list(prefix) {
      const { blobs } = await s().list({ prefix });
      return blobs.map((b) => b.key);
    },
    // Presigned URL: the browser uploads straight to Blob storage, so large files skip the function.
    async createUploadUrl(key, { expireSeconds = 1800 } = {}) {
      checkKey(key);
      const contentType = "application/octet-stream";
      const { url } = await s().createUploadUrl(key, { expireSeconds, contentType });
      return { url, method: "PUT", headers: { "Content-Type": contentType } };
    },
  };
}

let driver = null;

function use(name) {
  if (driver && driver.name === name) return driver;
  if (name === "blob") driver = blobDriver();
  else if (name === "fs") driver = fsDriver();
  else throw new Error(`Unknown storage driver "${name}" (use "fs" or "blob")`);
  return driver;
}

const current = () => driver || use("fs");

module.exports = {
  ROOT,
  use,
  get name() {
    return current().name;
  },
  get dir() {
    return current().dir;
  },
  getBytes: (key) => current().getBytes(key),
  putBytes: (key, buf, opts) => current().putBytes(key, buf, opts),
  delete: (key) => current().delete(key),
  list: (prefix) => current().list(prefix),
  createUploadUrl: (key, opts) => current().createUploadUrl(key, opts),
  verifyUpload: (query) => Boolean(current().verifyUpload && current().verifyUpload(query)),
  async getJSON(key) {
    const buf = await current().getBytes(key);
    return buf ? JSON.parse(buf.toString("utf8")) : null;
  },
  putJSON: (key, value, opts) => current().putBytes(key, Buffer.from(JSON.stringify(value)), opts),
};
