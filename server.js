require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const config = require("./site.config");
const store = require("./lib/store");
const auth = require("./lib/auth");
const pdf = require("./lib/pdf");
const stamps = require("./lib/stamp");
const mail = require("./lib/mailer");
const { sniff, MIME, safeName } = require("./lib/files");
const { HttpError } = require("./lib/errors");
const { rateLimit } = require("./lib/limit");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const TMP_DIR = path.join(store.DATA_DIR, "tmp");
const A = config.attestation;
const MB = 1024 * 1024;

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

/* ---------- Helpers ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (value, max, multiline = false) => {
  let s = String(value ?? "").normalize("NFC");
  s = multiline ? s.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max);
};
const now = () => new Date().toISOString();
const stampDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
const shortName = (name) => {
  const [first, ...rest] = String(name).trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
};
const removeTemp = (files) => [].concat(files || []).forEach((f) => f && fs.rm(f.path, { force: true }, () => {}));

// Sends an email in the background and records the outcome on the request.
function notify(type, req) {
  mail
    .send(type, req)
    .then((entry) => store.update(req.id, (r) => r.emails.push(entry)))
    .catch((err) => console.error("[mail]", err));
}

function publicView(r) {
  const view = {
    ref: r.ref,
    status: r.status,
    name: r.client.name,
    title: r.document.title,
    pages: r.document.pages,
    createdAt: r.createdAt,
    requireVerification: A.requirePaymentVerification,
    revoked: Boolean(r.revoked),
  };
  if (r.review) {
    view.attestedOn = r.review.attestedDate || null;
    view.rejectReason = r.status === "rejected" ? r.review.rejectReason : undefined;
    if (r.review.fee !== undefined) view.fee = { amount: r.review.fee, currency: r.review.currency };
  }
  if (["awaiting_payment", "payment_review"].includes(r.status)) view.bank = A.bank;
  if (r.payment) {
    view.slipUploadedAt = r.payment.slip ? r.payment.slip.uploadedAt : null;
    view.paymentNote = r.status === "awaiting_payment" ? r.payment.rejectedNote || null : null;
  }
  view.canDownload = r.status === "completed" && !r.revoked;
  return view;
}

function adminSummary(r) {
  return {
    id: r.id,
    ref: r.ref,
    status: r.status,
    name: r.client.name,
    email: r.client.email,
    title: r.document.title,
    pages: r.document.pages,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasSlip: Boolean(r.payment && r.payment.slip),
    revoked: Boolean(r.revoked),
  };
}

function adminView(r) {
  const { token, ...rest } = r;
  return { ...rest, trackUrl: mail.trackUrl(r), requireVerification: A.requirePaymentVerification };
}

/* ---------- Pages ---------- */

app.get("/site-config.js", (req, res) => {
  const site = {
    firmName: config.firmName,
    attorneyName: config.attorneyName,
    licenseNo: config.licenseNo,
    phone: config.phone,
    whatsapp: config.whatsapp,
    email: config.email,
    address: config.address,
    hours: config.hours,
    attestation: { currency: A.currency, maxFiles: A.maxFiles, maxFileMB: A.maxFileMB, maxTotalMB: A.maxTotalMB },
  };
  res.type("application/javascript").set("Cache-Control", "no-cache").send(`window.SITE = ${JSON.stringify(site)};\n`);
});

app.get("/track/:token", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "track.html")));
app.get("/verify", (req, res) => {
  const ref = typeof req.query.ref === "string" ? `?ref=${encodeURIComponent(req.query.ref)}` : "";
  res.redirect(302, `/attest${ref}#verify`);
});
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

/* ---------- Public API ---------- */

const api = express.Router();
api.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
api.use(express.json({ limit: "100kb" }));

const uploadDocs = multer({
  dest: TMP_DIR,
  defParamCharset: "utf8",
  limits: { fileSize: A.maxFileMB * MB, files: A.maxFiles, fields: 20, fieldSize: 16 * 1024 },
});
const uploadStamp = multer({
  dest: TMP_DIR,
  limits: { fileSize: 8 * MB, files: 1, fields: 2 },
});
const uploadSlip = multer({
  dest: TMP_DIR,
  defParamCharset: "utf8",
  limits: { fileSize: 10 * MB, files: 1, fields: 5 },
});

api.post("/attestations", rateLimit("submit", 30, 3600_000), uploadDocs.array("files", A.maxFiles), async (req, res) => {
  const files = req.files || [];
  try {
    const b = req.body || {};
    if (b.website) throw new HttpError(400, "Your request could not be submitted.");
    const client = {
      name: clean(b.name, 120),
      email: clean(b.email, 160).toLowerCase(),
      phone: clean(b.phone, 40),
      idNumber: clean(b.idNumber, 60),
    };
    const title = clean(b.title, 160);
    const notes = clean(b.notes, 2000, true);
    if (!client.name) throw new HttpError(400, "Please enter your full name.");
    if (!EMAIL_RE.test(client.email)) throw new HttpError(400, "Please enter a valid email address.");
    if (client.phone.replace(/\D/g, "").length < 6) throw new HttpError(400, "Please enter a valid phone number.");
    if (!title) throw new HttpError(400, "Please describe the document (for example, “Degree certificate”).");
    if (b.declaration !== "yes") throw new HttpError(400, "Please confirm the declaration to continue.");
    if (!files.length) throw new HttpError(400, "Please attach the document you want attested.");
    if (files.reduce((sum, f) => sum + f.size, 0) > A.maxTotalMB * MB) {
      throw new HttpError(413, `All files together must be smaller than ${A.maxTotalMB} MB.`);
    }

    const parts = [];
    for (const f of files) {
      const buf = await fs.promises.readFile(f.path);
      const kind = sniff(buf);
      const name = safeName(f.originalname, "document");
      if (!kind) throw new HttpError(400, `"${name}" is not a PDF, JPG or PNG file.`);
      parts.push({ buf, kind, name, size: f.size });
    }
    const built = await pdf.buildDocument(parts, title);

    const record = store.create({
      client,
      document: {
        title,
        notes,
        pages: built.pages.length,
        pageSizes: built.pages,
        files: parts.map((p, i) => ({ name: p.name, kind: p.kind, size: p.size, stored: `original-${i + 1}.${p.kind}` })),
      },
    });
    try {
      parts.forEach((p, i) => fs.writeFileSync(store.filePath(record, `original-${i + 1}.${p.kind}`), p.buf));
      fs.writeFileSync(store.filePath(record, "document.pdf"), built.bytes);
    } catch (err) {
      store.remove(record.id);
      throw err;
    }

    notify("received", record);
    notify("newRequest", record);
    res.status(201).json({ ref: record.ref, trackUrl: `/track/${record.token}`, email: client.email });
  } finally {
    removeTemp(files);
  }
});

const byToken = (token) => {
  const r = store.byToken(token);
  if (!r) throw new HttpError(404, "We could not find this request. Please check the link in your email.");
  return r;
};

api.get("/track/:token", (req, res) => res.json(publicView(byToken(req.params.token))));

api.post("/track/:token/slip", rateLimit("slip", 20, 3600_000), uploadSlip.single("slip"), async (req, res) => {
  try {
    const r = byToken(req.params.token);
    if (!["awaiting_payment", "payment_review"].includes(r.status)) {
      throw new HttpError(409, "A payment slip is not needed for this request right now.");
    }
    if (!req.file) throw new HttpError(400, "Please choose your payment slip (PDF, JPG or PNG).");
    const buf = await fs.promises.readFile(req.file.path);
    const kind = sniff(buf);
    if (!kind) throw new HttpError(400, "The payment slip must be a PDF, JPG or PNG file.");
    const stored = `slip-${Date.now()}.${kind}`;
    await fs.promises.writeFile(store.filePath(r, stored), buf);

    const updated = store.update(
      r.id,
      (x) => {
        x.payment = x.payment || { previousSlips: [] };
        if (x.payment.slip) x.payment.previousSlips.push(x.payment.slip);
        x.payment.slip = { name: safeName(req.file.originalname, `slip.${kind}`), kind, size: req.file.size, stored, uploadedAt: now() };
        x.payment.rejectedNote = null;
        x.payment.confirmedAt = null;
        x.status = A.requirePaymentVerification ? "payment_review" : "completed";
      },
      "payment slip uploaded"
    );
    notify("slipUploaded", updated);
    res.json(publicView(updated));
  } finally {
    removeTemp(req.file);
  }
});

api.get("/track/:token/download", (req, res) => {
  const r = byToken(req.params.token);
  if (r.revoked) throw new HttpError(403, "This attestation has been withdrawn. Please contact the office.");
  if (r.status !== "completed") throw new HttpError(403, "Your attested copy will be available once the payment slip is uploaded.");
  if (!fs.existsSync(store.filePath(r, "attested.pdf"))) throw new HttpError(404, "The attested file is missing. Please contact the office.");
  store.update(r.id, (x) => {
    x.downloads = (x.downloads || 0) + 1;
    x.lastDownloadAt = now();
  });
  res.download(store.filePath(r, "attested.pdf"), `Attested-${r.ref}.pdf`);
});

api.get("/verify/:ref", rateLimit("verify", 30, 60_000), (req, res) => {
  const r = store.byRef(req.params.ref);
  if (!r || !r.review || !r.review.attestedAt || r.status === "rejected") return res.json({ found: false });
  res.json({
    found: true,
    valid: !r.revoked,
    ref: r.ref,
    attestedOn: r.review.attestedDate,
    attorney: config.attorneyName,
    licenseNo: config.licenseNo,
    holder: shortName(r.client.name),
    title: r.document.title,
    pages: r.document.pages,
  });
});

/* ---------- Attorney API ---------- */

const admin = express.Router();

// Every change must come from the dashboard's own scripts (blocks cross-site form posts).
admin.use((req, res, next) => {
  if (req.method !== "GET" && req.get("X-Requested-With") !== "fetch") {
    return next(new HttpError(403, "Request blocked."));
  }
  next();
});

admin.get("/session", (req, res) => {
  const signedIn = auth.isSignedIn(req);
  res.json({
    signedIn,
    configured: auth.isConfigured(),
    ...(signedIn && {
      stamp: config.stamp,
      defaultFee: A.defaultFee,
      currency: A.currency,
      requireVerification: A.requirePaymentVerification,
      emailConfigured: mail.isConfigured(),
      stampInstalled: Boolean(stamps.current()),
      timezone: config.timezone,
    }),
  });
});

admin.post("/login", rateLimit("login", 10, 15 * 60_000), (req, res) => {
  if (!auth.isConfigured()) throw new HttpError(503, "The dashboard password has not been set up yet (ADMIN_PASSWORD).");
  if (!auth.checkPassword((req.body || {}).password || "")) throw new HttpError(401, "Incorrect password.");
  auth.setSession(res);
  res.json({ ok: true });
});

admin.post("/logout", (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

admin.use(auth.requireAdmin);

const need = (id) => {
  const r = store.get(id);
  if (!r) throw new HttpError(404, "Request not found.");
  return r;
};
const sendStored = (res, r, name, type, download) => {
  const file = store.filePath(r, name);
  if (!fs.existsSync(file)) throw new HttpError(404, "File not found.");
  res.type(type);
  if (download) res.attachment(download);
  res.sendFile(file);
};

admin.get("/requests", (req, res) => res.json(store.all().map(adminSummary)));
admin.get("/requests/:id", (req, res) => res.json(adminView(need(req.params.id))));
admin.get("/requests/:id/document", (req, res) => sendStored(res, need(req.params.id), "document.pdf", "application/pdf"));
admin.get("/requests/:id/attested", (req, res) => {
  const r = need(req.params.id);
  sendStored(res, r, "attested.pdf", "application/pdf", req.query.download ? `Attested-${r.ref}.pdf` : null);
});
admin.get("/requests/:id/original/:n", (req, res) => {
  const r = need(req.params.id);
  const f = r.document.files[Number(req.params.n)];
  if (!f) throw new HttpError(404, "File not found.");
  sendStored(res, r, f.stored, MIME[f.kind], f.name);
});
admin.get("/requests/:id/slip", (req, res) => {
  const r = need(req.params.id);
  const slip = r.payment && r.payment.slip;
  if (!slip) throw new HttpError(404, "No payment slip uploaded.");
  sendStored(res, r, slip.stored, MIME[slip.kind]);
});
admin.get("/stamp.png", (req, res) => {
  const stamp = stamps.current();
  if (!stamp) throw new HttpError(404, "No stamp uploaded yet.");
  res.type("image/png").set("Cache-Control", "private, no-cache");
  res.send(req.query.white === "0" ? stamp.transparent : stamp.white);
});
admin.post("/stamp", uploadStamp.single("stamp"), async (req, res) => {
  try {
    if (!req.file) throw new HttpError(400, "Please choose the stamp image (PNG).");
    let size;
    try {
      size = stamps.save(await fs.promises.readFile(req.file.path));
    } catch (err) {
      throw new HttpError(400, err.message.startsWith("The stamp") ? err.message : "The stamp must be a valid PNG image.");
    }
    const expected = config.stamp.width / config.stamp.height;
    const warning =
      Math.abs(size.width / size.height - expected) > 0.02
        ? `This image is ${size.width}×${size.height}px, which is a different shape from the original stamp. Check the date and reference position on a test document.`
        : null;
    res.json({ ok: true, ...size, warning });
  } finally {
    removeTemp(req.file);
  }
});

admin.post("/requests/:id/approve", async (req, res) => {
  const r = need(req.params.id);
  if (!["pending", "awaiting_payment"].includes(r.status)) {
    throw new HttpError(409, "This request has already been paid for or closed, so it cannot be stamped again.");
  }
  const body = req.body || {};
  const fee = Math.round(Number(body.fee) * 100) / 100;
  if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) throw new HttpError(400, "Please enter a valid fee (0 or more).");
  const placements = pdf.cleanPlacements(body.placements, r.document.pageSizes);
  if (!placements.length) throw new HttpError(400, "Place the stamp on at least one page.");

  const white = body.white !== false;
  const date = stampDate();
  const source = await fs.promises.readFile(store.filePath(r, "document.pdf"));
  const bytes = await pdf.stampDocument(source, { placements, white, date, ref: r.ref });
  await fs.promises.writeFile(store.filePath(r, "attested.pdf"), bytes);

  const first = r.status === "pending";
  const updated = store.update(
    r.id,
    (x) => {
      x.review = {
        ...x.review,
        placements,
        white,
        fee,
        currency: A.currency,
        attestedAt: now(),
        attestedDate: date,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
      if (fee === 0) x.status = "completed";
      else if (first) x.status = "awaiting_payment";
    },
    first ? "approved and attested" : "stamp updated"
  );
  if (first || body.notify) notify("approved", updated);
  res.json(adminView(updated));
});

admin.post("/requests/:id/reject", (req, res) => {
  const r = need(req.params.id);
  if (r.status !== "pending") throw new HttpError(409, "Only requests waiting for review can be declined.");
  const reason = clean((req.body || {}).reason, 1000, true);
  if (!reason) throw new HttpError(400, "Please tell the client why the document cannot be attested.");
  const updated = store.update(
    r.id,
    (x) => {
      x.status = "rejected";
      x.review = { ...x.review, rejectReason: reason, decidedAt: now() };
    },
    "declined"
  );
  notify("rejected", updated);
  res.json(adminView(updated));
});

admin.post("/requests/:id/payment", (req, res) => {
  const r = need(req.params.id);
  const { action } = req.body || {};
  if (!r.payment || !r.payment.slip) throw new HttpError(409, "No payment slip has been uploaded yet.");
  if (!["payment_review", "completed"].includes(r.status)) throw new HttpError(409, "There is no payment to review.");
  let updated;
  if (action === "confirm") {
    const wasWaiting = r.status === "payment_review";
    updated = store.update(
      r.id,
      (x) => {
        x.payment.confirmedAt = now();
        x.status = "completed";
      },
      "payment confirmed"
    );
    if (wasWaiting) notify("ready", updated);
  } else if (action === "reject") {
    const note = clean((req.body || {}).note, 600, true);
    updated = store.update(
      r.id,
      (x) => {
        x.payment.rejectedNote = note || "The payment slip did not match a payment in our account.";
        x.payment.confirmedAt = null;
        x.status = "awaiting_payment";
      },
      "payment slip not accepted"
    );
    notify("paymentRejected", updated);
  } else {
    throw new HttpError(400, "Unknown action.");
  }
  res.json(adminView(updated));
});

admin.post("/requests/:id/resend", (req, res) => {
  const r = need(req.params.id);
  const type = { pending: "received", rejected: "rejected", awaiting_payment: "approved", completed: "ready" }[r.status];
  if (!type) throw new HttpError(409, "There is no email to resend at this stage.");
  notify(type, r);
  res.json({ ok: true });
});

admin.post("/requests/:id/revoke", (req, res) => {
  const r = need(req.params.id);
  if (!r.review || !r.review.attestedAt) throw new HttpError(409, "This document has not been attested.");
  const revoked = Boolean((req.body || {}).revoked);
  res.json(adminView(store.update(r.id, (x) => (x.revoked = revoked), revoked ? "attestation withdrawn" : "attestation restored")));
});

admin.delete("/requests/:id", (req, res) => {
  need(req.params.id);
  store.remove(req.params.id);
  res.json({ ok: true });
});

api.use("/admin", admin);
app.use("/api", api);
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html")));

/* ---------- Errors ---------- */

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: `Each file must be smaller than ${A.maxFileMB} MB.`,
  LIMIT_FILE_COUNT: `You can upload up to ${A.maxFiles} files at a time.`,
  LIMIT_UNEXPECTED_FILE: `You can upload up to ${A.maxFiles} files at a time.`,
};

app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.expose || status < 500 ? err.message : "Something went wrong on our side. Please try again.";
  if (err instanceof multer.MulterError) {
    status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message = MULTER_MESSAGES[err.code] || "The upload could not be processed. Please try again.";
  }
  if (status >= 500) console.error(err);
  if (req.originalUrl.startsWith("/api/")) return res.status(status).json({ error: message });
  res.status(status).type("text").send(message);
});

app.listen(PORT, () => {
  console.log(`HL Attorney at Law is running on http://localhost:${PORT}`);
  if (!process.env.PUBLIC_URL) console.warn("[setup] PUBLIC_URL is not set: links in emails will point to localhost.");
  if (!auth.isConfigured()) console.warn("[setup] ADMIN_PASSWORD is not set (min. 8 characters): the attorney dashboard is locked.");
  if (!mail.isConfigured()) console.warn("[setup] SMTP is not set up: emails are saved to data/outbox instead of being sent.");
  if (!stamps.current()) console.warn("[setup] No attestation stamp yet: upload it in the dashboard (Stamp button) before approving.");
  if (/^0+$/.test(A.bank.accountNumber)) console.warn("[setup] BANK_ACCOUNT_NUMBER is still the placeholder. Set the real account in .env.");
});
