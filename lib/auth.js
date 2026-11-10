// Password login for the attorney's dashboard, using a signed, HttpOnly session cookie.
const crypto = require("crypto");

const COOKIE = "hl_admin";
const SESSION_HOURS = 12;
const PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SECURE = (process.env.PUBLIC_URL || "").startsWith("https://");

if (!process.env.SESSION_SECRET) {
  console.warn("[auth] SESSION_SECRET is not set: the attorney will be signed out whenever the server restarts.");
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sign = (value) => crypto.createHmac("sha256", SECRET).update(value).digest("base64url");

const isConfigured = () => PASSWORD.length >= 8;

function checkPassword(input) {
  if (!isConfigured()) return false;
  return crypto.timingSafeEqual(sha(input), sha(PASSWORD));
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSession(res) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const value = `${exp}.${sign(`admin.${exp}`)}`;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${SECURE ? "; Secure" : ""}`
  );
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE ? "; Secure" : ""}`);
}

function isSignedIn(req) {
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [exp, mac] = value.split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = sign(`admin.${exp}`);
  return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  if (isSignedIn(req)) return next();
  res.status(401).json({ error: "Please sign in." });
}

module.exports = { isConfigured, checkPassword, setSession, clearSession, isSignedIn, requireAdmin };
