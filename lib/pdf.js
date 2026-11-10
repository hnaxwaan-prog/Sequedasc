// Turns uploads into one PDF, and prints the attorney's stamp (with date and reference) onto it.
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");
const config = require("../site.config");
const stamps = require("./stamp");
const { jpegOrientation } = require("./files");
const { HttpError } = require("./errors");

const S = config.stamp;
const A4 = [595.28, 841.89];
// EXIF orientation -> clockwise page rotation (mirrored variants are shown unmirrored)
const EXIF_ROTATION = { 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

// Rotation and visible area exactly as PDF viewers (pdf.js) use them.
function rotationOf(page) {
  const angle = page.getRotation().angle;
  if (angle % 90 !== 0) return 0;
  return ((angle % 360) + 360) % 360;
}

function visibleBox(page) {
  const norm = (b) => ({
    x1: Math.min(b.x, b.x + b.width),
    y1: Math.min(b.y, b.y + b.height),
    x2: Math.max(b.x, b.x + b.width),
    y2: Math.max(b.y, b.y + b.height),
  });
  const m = norm(page.getMediaBox());
  const c = norm(page.getCropBox());
  const box = { x1: Math.max(m.x1, c.x1), y1: Math.max(m.y1, c.y1), x2: Math.min(m.x2, c.x2), y2: Math.min(m.y2, c.y2) };
  const b = box.x2 > box.x1 && box.y2 > box.y1 ? box : m;
  return { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 };
}

// Size of each page as the reader sees it (after rotation), in points.
function pageSizes(doc) {
  return doc.getPages().map((page) => {
    const r = rotationOf(page);
    const box = visibleBox(page);
    const sideways = r % 180 !== 0;
    return { w: round(sideways ? box.height : box.width), h: round(sideways ? box.width : box.height) };
  });
}

const round = (n) => Math.round(n * 100) / 100;

async function buildDocument(parts, title) {
  const out = await PDFDocument.create();
  for (const part of parts) {
    if (part.kind === "pdf") {
      let pages;
      try {
        const src = await PDFDocument.load(part.buf, { updateMetadata: false });
        pages = await out.copyPages(src, src.getPageIndices());
      } catch (err) {
        if (/encrypt/i.test(err.message)) {
          throw new HttpError(400, `"${part.name}" is password-protected. Please upload a copy without a password.`);
        }
        throw new HttpError(400, `"${part.name}" could not be opened as a PDF. Please check the file and try again.`);
      }
      pages.forEach((p) => out.addPage(p));
    } else {
      let img;
      try {
        img = part.kind === "jpg" ? await out.embedJpg(part.buf) : await out.embedPng(part.buf);
      } catch {
        throw new HttpError(400, `"${part.name}" could not be opened as an image. Please upload a JPG, PNG or PDF.`);
      }
      const rotation = part.kind === "jpg" ? EXIF_ROTATION[jpegOrientation(part.buf)] || 0 : 0;
      const sideways = rotation % 180 !== 0;
      const shownW = sideways ? img.height : img.width;
      const shownH = sideways ? img.width : img.height;
      const [maxW, maxH] = shownW > shownH ? [A4[1], A4[0]] : A4;
      const scale = Math.min(maxW / shownW, maxH / shownH);
      const page = out.addPage([img.width * scale, img.height * scale]);
      page.drawImage(img, { x: 0, y: 0, width: img.width * scale, height: img.height * scale });
      if (rotation) page.setRotation(degrees(rotation));
    }
  }
  if (out.getPageCount() === 0) throw new HttpError(400, "The uploaded document has no pages.");
  out.setTitle(title);
  out.setProducer(config.firmName);
  out.setCreator(config.firmName);
  return { bytes: await out.save(), pages: pageSizes(out) };
}

// Keeps each stamp inside its page and drops anything malformed.
function cleanPlacements(list, sizes) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const p of list) {
    const page = Number(p && p.page);
    if (!Number.isInteger(page) || page < 0 || page >= sizes.length || seen.has(page)) continue;
    const { w: pw, h: ph } = sizes[page];
    const ratio = (S.height / S.width) * (pw / ph); // stamp height as a fraction of page height, per unit of width
    let w = clamp(Number(p.w), 0.04, 0.95);
    if (w * ratio > 0.95) w = 0.95 / ratio;
    const x = clamp(Number(p.x), 0, 1 - w);
    const y = clamp(Number(p.y), 0, 1 - w * ratio);
    if (![w, x, y].every(Number.isFinite)) continue;
    seen.add(page);
    result.push({ page, x: round4(x), y: round4(y), w: round4(w) });
  }
  return result.sort((a, b) => a.page - b.page);
}

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : NaN);
const round4 = (n) => Math.round(n * 10000) / 10000;

// Maps a point measured from the top-left of the page as displayed to PDF user space.
function displayToPdf(u, v, rotation, box) {
  const { x, y, width: W, height: H } = box;
  switch (rotation) {
    case 90: return { x: x + v, y: y + u };
    case 180: return { x: x + W - u, y: y + v };
    case 270: return { x: x + W - v, y: y + H - u };
    default: return { x: x + u, y: y + H - v };
  }
}

const fitSize = (font, text, size, maxWidth) => {
  const width = font.widthOfTextAtSize(text, size);
  return width > maxWidth ? (size * maxWidth) / width : size;
};

async function stampDocument(bytes, { placements, white, date, ref }) {
  const stamp = stamps.current();
  if (!stamp) throw new HttpError(409, "Upload your attestation stamp first, using the Stamp button at the top of the dashboard.");
  const doc = await PDFDocument.load(bytes);
  const image = await doc.embedPng(white ? stamp.white : stamp.transparent);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const color = rgb(S.color[0] / 255, S.color[1] / 255, S.color[2] / 255);
  const pages = doc.getPages();

  // Text positions on the stamp, in stamp pixels (independent of page placement).
  const dateSize = fitSize(bold, date, S.date.size, S.date.maxWidth);
  const dateLeft = S.date.centerX - bold.widthOfTextAtSize(date, dateSize) / 2;
  const label = "Ref: ";
  const refWidthAt = (size) => regular.widthOfTextAtSize(label, size) + bold.widthOfTextAtSize(ref, size);
  const refSize = Math.min(S.ref.size, (S.ref.size * S.ref.maxWidth) / refWidthAt(S.ref.size));
  const refLeft = S.ref.right - refWidthAt(refSize);
  const refCodeLeft = refLeft + regular.widthOfTextAtSize(label, refSize);

  for (const p of placements) {
    const page = pages[p.page];
    const rotation = rotationOf(page);
    const box = visibleBox(page);
    const shownW = rotation % 180 ? box.height : box.width;
    const shownH = rotation % 180 ? box.width : box.height;
    const k = (p.w * shownW) / S.width; // points per stamp pixel
    const left = p.x * shownW;
    const top = p.y * shownH;
    const at = (sx, sy) => displayToPdf(left + sx * k, top + sy * k, rotation, box);
    const rotate = degrees(rotation);

    const origin = at(0, S.height); // bottom-left corner of the stamp as displayed
    page.drawImage(image, { ...origin, width: S.width * k, height: S.height * k, rotate });
    page.drawText(date, { ...at(dateLeft, S.date.baseline), size: dateSize * k, font: bold, color, rotate });
    page.drawText(label, { ...at(refLeft, S.ref.baseline), size: refSize * k, font: regular, color, rotate });
    page.drawText(ref, { ...at(refCodeLeft, S.ref.baseline), size: refSize * k, font: bold, color, rotate });
  }

  doc.setTitle(`Attested copy ${ref}`);
  doc.setAuthor(`${config.attorneyName}, ${config.firmName}`);
  doc.setSubject(`True copy attested by ${config.attorneyName} (Licence ${config.licenseNo}) on ${date}. Ref ${ref}`);
  doc.setKeywords(["attested", ref]);
  doc.setProducer(config.firmName);
  doc.setModificationDate(new Date());
  return doc.save();
}

module.exports = { buildDocument, cleanPlacements, stampDocument };
