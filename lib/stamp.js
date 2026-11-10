// The attorney's stamp image. It contains a real signature, so it is never stored in git:
// the attorney uploads it once in the dashboard (kept in storage under stamp/stamp.png),
// or, on a Node server, it can be copied by hand to private/stamp.png.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const UPNG = require("@pdf-lib/upng").default;
const storage = require("./storage");

const KEY = "stamp/stamp.png";
const LOCAL = path.join(storage.ROOT, "private", "stamp.png");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let cache = null;

// Same stamp with everything inside its outer border filled white, for busy backgrounds.
function whiteFilled(png) {
  const img = UPNG.decode(png);
  const { width: w, height: h } = img;
  const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (i) => {
    if (!outside[i] && rgba[i * 4 + 3] <= 40) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  for (let i = 0; i < w * h; i++) {
    if (outside[i]) continue;
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(rgba[i * 4 + c] * a + 255 * (1 - a));
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(UPNG.encode([rgba.buffer], w, h, 0));
}

async function current() {
  let transparent = await storage.getBytes(KEY);
  if (!transparent && storage.name === "fs" && fs.existsSync(LOCAL)) transparent = fs.readFileSync(LOCAL);
  if (!transparent) return null;
  const hash = crypto.createHash("sha1").update(transparent).digest("hex");
  if (cache && cache.hash === hash) return cache;
  try {
    const { width, height } = UPNG.decode(transparent);
    cache = { hash, width, height, transparent, white: whiteFilled(transparent) };
    return cache;
  } catch (err) {
    console.error("[stamp] The stored stamp could not be read:", err.message);
    return null;
  }
}

// Validates and stores a newly uploaded stamp. Returns its pixel size.
async function save(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("The stamp must be a PNG image.");
  let width, height;
  try {
    ({ width, height } = UPNG.decode(buf));
  } catch {
    throw new Error("The stamp must be a valid PNG image.");
  }
  if (width < 400 || height < 200) throw new Error("The stamp image is too small. Please upload a high-resolution PNG.");
  await storage.putBytes(KEY, buf);
  cache = null;
  return { width, height };
}

module.exports = { current, save };
