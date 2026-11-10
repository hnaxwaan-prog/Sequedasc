// Tiny JSON-file database for attestation requests.
// Everything is kept in memory and written atomically to DATA_DIR/requests.json.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const DB_FILE = path.join(DATA_DIR, "requests.json");
const FILES_DIR = path.join(DATA_DIR, "files");

fs.mkdirSync(FILES_DIR, { recursive: true });

let requests = [];
if (fs.existsSync(DB_FILE)) {
  requests = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function save() {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(requests, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// No look-alike characters (0/O, 1/I/L), so references are easy to type when verifying.
const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newRef() {
  let ref;
  do {
    ref = "UZHL-" + Array.from({ length: 10 }, () => REF_CHARS[crypto.randomInt(REF_CHARS.length)]).join("");
  } while (requests.some((r) => r.ref === ref));
  return ref;
}

function create(data) {
  const now = new Date().toISOString();
  const req = {
    id: "r" + crypto.randomBytes(8).toString("hex"),
    ref: newRef(),
    token: crypto.randomBytes(24).toString("hex"),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    downloads: 0,
    history: [{ at: now, event: "submitted" }],
    emails: [],
    ...data,
  };
  fs.mkdirSync(dirFor(req), { recursive: true });
  requests.push(req);
  save();
  return req;
}

function update(id, mutate, event) {
  const req = get(id);
  if (!req) return null;
  mutate(req);
  req.updatedAt = new Date().toISOString();
  if (event) req.history.push({ at: req.updatedAt, event });
  save();
  return req;
}

function remove(id) {
  const req = get(id);
  if (!req) return false;
  fs.rmSync(dirFor(req), { recursive: true, force: true });
  requests = requests.filter((r) => r.id !== id);
  save();
  return true;
}

const get = (id) => requests.find((r) => r.id === id) || null;
const byToken = (token) =>
  (typeof token === "string" && token.length === 48 && requests.find((r) => r.token === token)) || null;
const byRef = (ref) => requests.find((r) => r.ref === String(ref).trim().toUpperCase()) || null;
const all = () => [...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const dirFor = (req) => path.join(FILES_DIR, req.id);
const filePath = (req, name) => path.join(dirFor(req), name);

module.exports = { DATA_DIR, create, update, remove, get, byToken, byRef, all, dirFor, filePath };
