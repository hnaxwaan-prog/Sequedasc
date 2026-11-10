// Attestation requests, stored as one JSON record per request with small lookup
// records for the client's private token and the public reference number.
const crypto = require("crypto");
const storage = require("./storage");

// No look-alike characters (0/O, 1/I/L), so references are easy to type when verifying.
const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ID_RE = /^r[0-9a-f]{16}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;
const REF_RE = /^UZHL-[A-Z0-9]{10}$/;

const recordKey = (id) => `requests/${id}.json`;
const newRef = () => "UZHL-" + Array.from({ length: 10 }, () => REF_CHARS[crypto.randomInt(REF_CHARS.length)]).join("");

// Updates to one request run one at a time, so parallel email logs don't overwrite each other.
const locks = new Map();
function withLock(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function get(id) {
  return ID_RE.test(String(id)) ? storage.getJSON(recordKey(id)) : null;
}

async function byToken(token) {
  if (!TOKEN_RE.test(String(token))) return null;
  const link = await storage.getJSON(`tokens/${token}.json`);
  return link ? get(link.id) : null;
}

async function byRef(ref) {
  const r = String(ref).trim().toUpperCase();
  if (!REF_RE.test(r)) return null;
  const link = await storage.getJSON(`refs/${r}.json`);
  return link ? get(link.id) : null;
}

async function all() {
  const keys = (await storage.list("requests/")).filter((k) => k.endsWith(".json"));
  const records = await mapLimit(keys, 16, (k) => storage.getJSON(k));
  return records.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function create(data) {
  const now = new Date().toISOString();
  const id = "r" + crypto.randomBytes(8).toString("hex");
  let ref;
  do ref = newRef();
  while (!(await storage.putJSON(`refs/${ref}.json`, { id }, { onlyIfNew: true })));
  const token = crypto.randomBytes(24).toString("hex");
  await storage.putJSON(`tokens/${token}.json`, { id });
  const req = {
    id,
    ref,
    token,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    downloads: 0,
    history: [{ at: now, event: "submitted" }],
    emails: [],
    ...data,
  };
  await storage.putJSON(recordKey(id), req);
  return req;
}

function update(id, mutate, event) {
  return withLock(id, async () => {
    const req = await get(id);
    if (!req) return null;
    mutate(req);
    req.updatedAt = new Date().toISOString();
    if (event) req.history.push({ at: req.updatedAt, event });
    await storage.putJSON(recordKey(id), req);
    return req;
  });
}

async function remove(id) {
  const req = await get(id);
  if (!req) return false;
  for (const key of await storage.list(`files/${id}/`)) await storage.delete(key);
  await storage.delete(`tokens/${req.token}.json`);
  await storage.delete(`refs/${req.ref}.json`);
  await storage.delete(recordKey(id));
  return true;
}

const putFile = (req, name, buf) => storage.putBytes(`files/${req.id}/${name}`, buf);
const getFile = (req, name) => storage.getBytes(`files/${req.id}/${name}`);

module.exports = { create, update, remove, get, byToken, byRef, all, putFile, getFile };
