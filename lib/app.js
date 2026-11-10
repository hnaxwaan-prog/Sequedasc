// The website's Express app. server.js runs it as a normal Node server (files on disk);
// on EdgeOne Pages, node-functions/api/[[default]].js runs it as a Node Function with Blob storage.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const config = require("../site.config");
const storage = require("./storage");
const store = require("./store");
const auth = require("./auth");
const pdf = require("./pdf");
const stamps = require("./stamp");
const mail = require("./mailer");
const { uploadLimits, configScript } = require("./public-config");
const { sniff, MIME, safeName } = require("./files");
const { HttpError } = require("./errors");
const { rateLimit } = require("./limit");

const A = config.attestation;
const MB = 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UPLOAD_KEY_RE = /^uploads\/\d{8}\/[0-9a-f]{32}$/;
const SLIP_STATES = ["awaiting_payment", "payment_review"];

/* ---------- Helpers ---------- */

const clean = (value, max, multiline = false) => {
  let s = String(value ?? "").normalize("NFC");
  s = multiline ? s.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max);
};
const now = () => new Date().toISOString();
const day = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, "");
const stampDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
const shortName = (name) => {
  const [first, ...rest] = String(name).trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
};

// Emails are awaited (a serverless function may be paused once it has responded); failures are only logged.
async function notify(type, req) {
  try {
    const entry = await mail.send(type, req);
    await store.update(req.id, (r) => r.emails.push(entry));
  } catch (err) {
    console.error("[mail]", err);
  }
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
  if (SLIP_STATES.includes(r.status)) view.bank = A.bank;
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

async function byToken(token) {
  const r = await store.byToken(token);
  if (!r) throw new HttpError(404, "We could not find this request. Please check the link in your email.");
  return r;
}

async function need(id) {
  const r = await store.get(id);
  if (!r) throw new HttpError(404, "Request not found.");
  return r;
}

async function sendStored(res, r, name, type, download) {
  const file = await store.getFile(r, name);
  if (!file) throw new HttpError(404, "File not found.");
  if (download) res.attachment(download);
  res.type(type).send(file);
}

// Deletes uploads that were never submitted (at most once an hour per server instance).
let lastSweep = 0;
async function sweepUploads() {
  if (Date.now() - lastSweep < 3600_000) return;
  lastSweep = Date.now();
  const cutoff = day(new Date(Date.now() - 2 * 86400_000));
  const stale = (await storage.list("uploads/")).filter((k) => k.split("/")[1] < cutoff);
  await Promise.all(stale.map((k) => storage.delete(k).catch(() => {})));
}

/* ---------- App ---------- */

function createApp({ driver = "fs", site = false, apiAtRoot = false, trustProxy } = {}) {
  storage.use(driver);
  const limits = uploadLimits(driver);
  const slipMaxMB = Math.min(10, limits.maxFileMB);
  const publicDir = path.join(storage.ROOT, "public");

  const app = express();
  app.disable("x-powered-by");
  const proxy = trustProxy ?? process.env.TRUST_PROXY;
  if (proxy) app.set("trust proxy", proxy === true || proxy === "true" ? 1 : proxy);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  /* ---------- Pages (Node server only; EdgeOne serves the static build) ---------- */

  if (site) {
    app.get("/site-config.js", (req, res) => {
      res.type("application/javascript").set("Cache-Control", "no-cache").send(configScript(driver));
    });
    app.get("/track/:token", (req, res) => res.sendFile(path.join(publicDir, "track.html")));
    app.get("/verify", (req, res) => {
      const ref = typeof req.query.ref === "string" ? `?ref=${encodeURIComponent(req.query.ref)}` : "";
      res.redirect(302, `/attest${ref}#verify`);
    });
    app.use(express.static(publicDir, { extensions: ["html"] }));
  }

  /* ---------- Public API ---------- */

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(express.json({ limit: "100kb" }));

  // Quick self-check, e.g. after a deployment: open /api/health in a browser.
  api.get("/health", async (req, res) => {
    let storageOk = true;
    try {
      await storage.list("stamp/");
    } catch (err) {
      storageOk = false;
      console.error("[health] storage:", err.message);
    }
    res.json({ ok: storageOk, storage: storageOk ? "ok" : "unavailable", passwordSet: auth.isConfigured(), emailSet: mail.isConfigured() });
  });

  // Step 1 of an upload: a short-lived URL the browser PUTs the file to.
  api.post("/uploads", rateLimit("upload", 80, 3600_000), async (req, res) => {
    const b = req.body || {};
    const slip = b.purpose === "slip";
    const maxMB = slip ? slipMaxMB : limits.maxFileMB;
    const size = Number(b.size);
    if (!(size > 0)) throw new HttpError(400, "This file is empty.");
    if (size > maxMB * MB) throw new HttpError(413, `Each file must be smaller than ${maxMB} MB.`);
    if (!/^(application\/pdf|image\/jpeg|image\/png)$/.test(String(b.type)) && !/\.(pdf|jpe?g|png)$/i.test(String(b.name))) {
      throw new HttpError(400, "Please upload a PDF, JPG or PNG file.");
    }
    if (slip && !SLIP_STATES.includes((await byToken(b.token)).status)) {
      throw new HttpError(409, "A payment slip is not needed for this request right now.");
    }
    const key = `uploads/${day()}/${crypto.randomBytes(16).toString("hex")}`;
    res.json({ key, ...(await storage.createUploadUrl(key, { expireSeconds: 1800 })) });
  });

  // On a Node server, uploads come back here (on EdgeOne they go straight to Blob storage).
  if (driver === "fs") {
    api.put("/uploads/local", express.raw({ type: () => true, limit: limits.maxFileMB * MB }), async (req, res) => {
      if (!UPLOAD_KEY_RE.test(String(req.query.key)) || !storage.verifyUpload(req.query)) {
        throw new HttpError(403, "This upload link has expired. Please try again.");
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "This file is empty.");
      await storage.putBytes(req.query.key, req.body);
      res.status(204).end();
    });
  }

  // Step 2: the form, with the keys of the uploaded files.
  api.post("/attestations", rateLimit("submit", 30, 3600_000), async (req, res) => {
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
    const uploads = Array.isArray(b.uploads) ? b.uploads : [];
    if (!uploads.length) throw new HttpError(400, "Please attach the document you want attested.");
    if (uploads.length > limits.maxFiles) throw new HttpError(400, `You can upload up to ${limits.maxFiles} files at a time.`);

    const parts = [];
    for (const u of uploads) {
      const key = String((u && u.key) || "");
      const buf = UPLOAD_KEY_RE.test(key) ? await storage.getBytes(key) : null;
      const name = safeName(u && u.name, "document");
      if (!buf) throw new HttpError(400, `"${name}" did not finish uploading. Please try again.`);
      if (buf.length > limits.maxFileMB * MB) throw new HttpError(413, `Each file must be smaller than ${limits.maxFileMB} MB.`);
      const kind = sniff(buf);
      if (!kind) throw new HttpError(400, `"${name}" is not a PDF, JPG or PNG file.`);
      parts.push({ buf, kind, name, size: buf.length, key });
    }
    if (parts.reduce((sum, p) => sum + p.size, 0) > limits.maxTotalMB * MB) {
      throw new HttpError(413, `All files together must be smaller than ${limits.maxTotalMB} MB.`);
    }
    const built = await pdf.buildDocument(parts, title);
    if (built.bytes.length > Math.max(limits.maxTotalMB, 5.5) * MB) {
      throw new HttpError(413, "This document is too large to attest online. Please upload smaller scans or photos.");
    }

    const record = await store.create({
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
      for (const [i, p] of parts.entries()) await store.putFile(record, `original-${i + 1}.${p.kind}`, p.buf);
      await store.putFile(record, "document.pdf", Buffer.from(built.bytes));
    } catch (err) {
      await store.remove(record.id).catch(() => {});
      throw err;
    }
    await Promise.all(parts.map((p) => storage.delete(p.key).catch(() => {})));
    await Promise.all([notify("received", record), notify("newRequest", record)]);
    res.status(201).json({ ref: record.ref, trackUrl: `/track/${record.token}`, email: client.email });
  });

  api.get("/track/:token", async (req, res) => res.json(publicView(await byToken(req.params.token))));

  api.post("/track/:token/slip", rateLimit("slip", 20, 3600_000), async (req, res) => {
    const r = await byToken(req.params.token);
    if (!SLIP_STATES.includes(r.status)) throw new HttpError(409, "A payment slip is not needed for this request right now.");
    const b = req.body || {};
    const buf = UPLOAD_KEY_RE.test(String(b.key)) ? await storage.getBytes(b.key) : null;
    if (!buf) throw new HttpError(400, "Your payment slip did not finish uploading. Please try again.");
    if (buf.length > slipMaxMB * MB) throw new HttpError(413, `The payment slip must be smaller than ${slipMaxMB} MB.`);
    const kind = sniff(buf);
    if (!kind) throw new HttpError(400, "The payment slip must be a PDF, JPG or PNG file.");
    const stored = `slip-${Date.now()}.${kind}`;
    await store.putFile(r, stored, buf);
    await storage.delete(b.key).catch(() => {});

    const updated = await store.update(
      r.id,
      (x) => {
        x.payment = x.payment || { previousSlips: [] };
        if (x.payment.slip) x.payment.previousSlips.push(x.payment.slip);
        x.payment.slip = { name: safeName(b.name, `slip.${kind}`), kind, size: buf.length, stored, uploadedAt: now() };
        x.payment.rejectedNote = null;
        x.payment.confirmedAt = null;
        x.status = A.requirePaymentVerification ? "payment_review" : "completed";
      },
      "payment slip uploaded"
    );
    await notify("slipUploaded", updated);
    res.json(publicView(updated));
  });

  api.get("/track/:token/download", async (req, res) => {
    const r = await byToken(req.params.token);
    if (r.revoked) throw new HttpError(403, "This attestation has been withdrawn. Please contact the office.");
    if (r.status !== "completed") throw new HttpError(403, "Your attested copy will be available once the payment slip is uploaded.");
    const file = await store.getFile(r, "attested.pdf");
    if (!file) throw new HttpError(404, "The attested file is missing. Please contact the office.");
    await store.update(r.id, (x) => {
      x.downloads = (x.downloads || 0) + 1;
      x.lastDownloadAt = now();
    });
    res.attachment(`Attested-${r.ref}.pdf`).type("application/pdf").send(file);
  });

  api.get("/verify/:ref", rateLimit("verify", 30, 60_000), async (req, res) => {
    const r = await store.byRef(req.params.ref);
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
  const uploadStamp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * MB, files: 1, fields: 2 } });

  // Every change must come from the dashboard's own scripts (blocks cross-site form posts).
  admin.use((req, res, next) => {
    if (req.method !== "GET" && req.get("X-Requested-With") !== "fetch") return next(new HttpError(403, "Request blocked."));
    next();
  });

  admin.get("/session", async (req, res) => {
    const signedIn = auth.isSignedIn(req);
    let stampInstalled = false;
    if (signedIn) {
      try {
        stampInstalled = Boolean(await stamps.current());
      } catch (err) {
        console.error("[stamp]", err);
      }
    }
    res.json({
      signedIn,
      configured: auth.isConfigured(),
      ...(signedIn && {
        stamp: config.stamp,
        defaultFee: A.defaultFee,
        currency: A.currency,
        requireVerification: A.requirePaymentVerification,
        emailConfigured: mail.isConfigured(),
        stampInstalled,
        weakPassword: auth.isWeak(),
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

  admin.get("/requests", async (req, res) => {
    await sweepUploads().catch((err) => console.error("[uploads]", err.message));
    res.json((await store.all()).map(adminSummary));
  });
  admin.get("/requests/:id", async (req, res) => res.json(adminView(await need(req.params.id))));
  admin.get("/requests/:id/document", async (req, res) => sendStored(res, await need(req.params.id), "document.pdf", "application/pdf"));
  admin.get("/requests/:id/attested", async (req, res) => {
    const r = await need(req.params.id);
    await sendStored(res, r, "attested.pdf", "application/pdf", req.query.download ? `Attested-${r.ref}.pdf` : null);
  });
  admin.get("/requests/:id/original/:n", async (req, res) => {
    const r = await need(req.params.id);
    const f = r.document.files[Number(req.params.n)];
    if (!f) throw new HttpError(404, "File not found.");
    await sendStored(res, r, f.stored, MIME[f.kind], f.name);
  });
  admin.get("/requests/:id/slip", async (req, res) => {
    const r = await need(req.params.id);
    const slip = r.payment && r.payment.slip;
    if (!slip) throw new HttpError(404, "No payment slip uploaded.");
    await sendStored(res, r, slip.stored, MIME[slip.kind]);
  });

  admin.get("/stamp.png", async (req, res) => {
    const stamp = await stamps.current();
    if (!stamp) throw new HttpError(404, "No stamp uploaded yet.");
    res.type("image/png").set("Cache-Control", "private, no-cache");
    res.send(req.query.white === "0" ? stamp.transparent : stamp.white);
  });
  admin.post("/stamp", uploadStamp.single("stamp"), async (req, res) => {
    if (!req.file) throw new HttpError(400, "Please choose the stamp image (PNG).");
    let size;
    try {
      size = await stamps.save(req.file.buffer);
    } catch (err) {
      throw /^The stamp/.test(err.message) ? new HttpError(400, err.message) : err;
    }
    const expected = config.stamp.width / config.stamp.height;
    const warning =
      Math.abs(size.width / size.height - expected) > 0.02
        ? `This image is ${size.width}×${size.height}px, which is a different shape from the original stamp. Check the date and reference position on a test document.`
        : null;
    res.json({ ok: true, ...size, warning });
  });

  admin.post("/requests/:id/approve", async (req, res) => {
    const r = await need(req.params.id);
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
    const source = await store.getFile(r, "document.pdf");
    if (!source) throw new HttpError(404, "The uploaded document is missing.");
    const bytes = await pdf.stampDocument(source, { placements, white, date, ref: r.ref });
    await store.putFile(r, "attested.pdf", Buffer.from(bytes));

    const first = r.status === "pending";
    const updated = await store.update(
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
    if (first || body.notify) await notify("approved", updated);
    res.json(adminView((await store.get(r.id)) || updated));
  });

  admin.post("/requests/:id/reject", async (req, res) => {
    const r = await need(req.params.id);
    if (r.status !== "pending") throw new HttpError(409, "Only requests waiting for review can be declined.");
    const reason = clean((req.body || {}).reason, 1000, true);
    if (!reason) throw new HttpError(400, "Please tell the client why the document cannot be attested.");
    const updated = await store.update(
      r.id,
      (x) => {
        x.status = "rejected";
        x.review = { ...x.review, rejectReason: reason, decidedAt: now() };
      },
      "declined"
    );
    await notify("rejected", updated);
    res.json(adminView((await store.get(r.id)) || updated));
  });

  admin.post("/requests/:id/payment", async (req, res) => {
    const r = await need(req.params.id);
    const { action } = req.body || {};
    if (!r.payment || !r.payment.slip) throw new HttpError(409, "No payment slip has been uploaded yet.");
    if (!["payment_review", "completed"].includes(r.status)) throw new HttpError(409, "There is no payment to review.");
    if (action === "confirm") {
      const wasWaiting = r.status === "payment_review";
      const updated = await store.update(
        r.id,
        (x) => {
          x.payment.confirmedAt = now();
          x.status = "completed";
        },
        "payment confirmed"
      );
      if (wasWaiting) await notify("ready", updated);
    } else if (action === "reject") {
      const note = clean((req.body || {}).note, 600, true);
      const updated = await store.update(
        r.id,
        (x) => {
          x.payment.rejectedNote = note || "The payment slip did not match a payment in our account.";
          x.payment.confirmedAt = null;
          x.status = "awaiting_payment";
        },
        "payment slip not accepted"
      );
      await notify("paymentRejected", updated);
    } else {
      throw new HttpError(400, "Unknown action.");
    }
    res.json(adminView(await store.get(r.id)));
  });

  admin.post("/requests/:id/resend", async (req, res) => {
    const r = await need(req.params.id);
    const type = { pending: "received", rejected: "rejected", awaiting_payment: "approved", completed: "ready" }[r.status];
    if (!type) throw new HttpError(409, "There is no email to resend at this stage.");
    await notify(type, r);
    res.json({ ok: true });
  });

  admin.post("/requests/:id/revoke", async (req, res) => {
    const r = await need(req.params.id);
    if (!r.review || !r.review.attestedAt) throw new HttpError(409, "This document has not been attested.");
    const revoked = Boolean((req.body || {}).revoked);
    res.json(adminView(await store.update(r.id, (x) => (x.revoked = revoked), revoked ? "attestation withdrawn" : "attestation restored")));
  });

  admin.delete("/requests/:id", async (req, res) => {
    await need(req.params.id);
    await store.remove(req.params.id);
    res.json({ ok: true });
  });

  api.use("/admin", admin);
  app.use("/api", api);
  // EdgeOne may hand the function the path with or without its /api prefix.
  if (apiAtRoot) app.use(api);
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
  if (site) app.use((req, res) => res.status(404).sendFile(path.join(publicDir, "404.html")));
  else app.use((req, res) => res.status(404).json({ error: "Not found." }));

  /* ---------- Errors ---------- */

  const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: "The stamp image must be smaller than 4 MB.",
    LIMIT_FILE_COUNT: "Please upload one file at a time.",
    LIMIT_UNEXPECTED_FILE: "Please upload one file at a time.",
  };

  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.expose || status < 500 ? err.message : "Something went wrong on our side. Please try again.";
    if (err instanceof multer.MulterError) {
      status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      message = MULTER_MESSAGES[err.code] || "The upload could not be processed. Please try again.";
    } else if (err.type === "entity.too.large") {
      message = `Each file must be smaller than ${limits.maxFileMB} MB.`;
    } else if (err.code === "QUOTA_EXCEEDED") {
      status = 507;
      message = "Online storage is full. Please contact the office.";
    } else if (err.name === "PagesBlobError") {
      status = 503;
      message = /(^|\/)admin(\/|$)/.test(req.originalUrl)
        ? `File storage is not available (${err.code || "error"}). In EdgeOne, check that Blob storage is enabled for this project, then redeploy.`
        : "Online attestation is temporarily unavailable. Please try again later or contact the office.";
    }
    if (status >= 500) console.error(err);
    if (!site || req.originalUrl.startsWith("/api/")) return res.status(status).json({ error: message });
    res.status(status).type("text").send(message);
  });

  return app;
}

module.exports = createApp;
