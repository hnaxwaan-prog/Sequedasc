// File type detection by content (never trust the browser's file name or MIME type).

function sniff(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.subarray(0, 1024).includes("%PDF-")) return "pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return null;
}

const MIME = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };

// Reads the EXIF orientation (1-8) of a JPEG so phone photos are not stamped sideways.
function jpegOrientation(buf) {
  try {
    return readOrientation(buf);
  } catch {
    return 1; // malformed EXIF: treat as upright
  }
}

function readOrientation(buf) {
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) return 1;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString("ascii", i + 4, i + 8) === "Exif") {
      const tiff = i + 10;
      const le = buf.toString("ascii", tiff, tiff + 2) === "II";
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      for (let n = 0; n < count; n++) {
        const entry = ifd + 2 + n * 12;
        if (entry + 12 > buf.length) break;
        if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
      }
      return 1;
    }
    if (marker === 0xda) return 1; // start of image data: no EXIF block
    i += 2 + len;
  }
  return 1;
}

// Clean, safe file name for downloads and display.
function safeName(name, fallback = "file") {
  const cleaned = String(name || "")
    .normalize("NFKC")
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/^[.\s]+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

module.exports = { sniff, MIME, jpegOrientation, safeName };
