// Email notifications. Uses SMTP when configured; otherwise saves each email to DATA_DIR/outbox.
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const config = require("../site.config");
const { DATA_DIR } = require("./store");

const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const FROM = process.env.MAIL_FROM || `${config.firmName} <${config.email}>`;
const LAWYER_EMAIL = process.env.LAWYER_EMAIL || config.email;
const OUTBOX = path.join(DATA_DIR, "outbox");

const port = Number(process.env.SMTP_PORT || 587);
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const trackUrl = (req) => `${PUBLIC_URL}/track/${req.token}`;
const adminUrl = (req) => `${PUBLIC_URL}/admin#${req.id}`;
const money = (req) => `${req.review.currency} ${Number(req.review.fee).toFixed(2)}`;

function layout({ heading, intro, rows = [], body = "", button, footnote = "" }) {
  const rowsHtml = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #ece5da;border-radius:10px;border-collapse:separate">
        ${rows
          .map(
            ([k, v], i) => `<tr><td style="padding:11px 16px;font-size:13px;color:#6f6960;width:40%;${i ? "border-top:1px solid #ece5da;" : ""}">${esc(k)}</td>
            <td style="padding:11px 16px;font-size:14px;color:#1d1b19;font-weight:600;${i ? "border-top:1px solid #ece5da;" : ""}">${esc(v)}</td></tr>`
          )
          .join("")}
      </table>`
    : "";
  const buttonHtml = button
    ? `<p style="margin:28px 0 8px"><a href="${esc(button.url)}" style="display:inline-block;background:#b3121b;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:999px">${esc(button.label)}</a></p>
       <p style="margin:0;font-size:12px;color:#8a8379">Or open this link: <a href="${esc(button.url)}" style="color:#b3121b;word-break:break-all">${esc(button.url)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f2ec;font-family:Helvetica,Arial,sans-serif;color:#3d3934">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f2ec;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ece5da">
      <tr><td style="padding:22px 32px;border-bottom:3px solid #b3121b">
        <img src="${PUBLIC_URL}/assets/logo.png" width="30" height="33" alt="" style="vertical-align:middle;margin-right:10px">
        <span style="font-family:Georgia,serif;font-size:19px;color:#1d1b19;vertical-align:middle"><b style="color:#b3121b">HL</b> Attorney at Law</span>
      </td></tr>
      <tr><td style="padding:32px">
        <h1 style="margin:0 0 14px;font-family:Georgia,serif;font-weight:normal;font-size:25px;color:#1d1b19">${esc(heading)}</h1>
        <p style="margin:0;font-size:15px;line-height:1.65">${intro}</p>
        ${rowsHtml}${body}${buttonHtml}
        ${footnote ? `<p style="margin:26px 0 0;font-size:13px;line-height:1.6;color:#6f6960">${footnote}</p>` : ""}
      </td></tr>
      <tr><td style="padding:20px 32px;background:#faf7f2;font-size:12px;line-height:1.6;color:#8a8379">
        ${esc(config.firmName)} · ${esc(config.attorneyName)} · Attorney licence ${esc(config.licenseNo)}<br>
        ${esc(config.address)} · ${esc(config.phone)} · ${esc(config.email)}
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

// Plain-text version for email clients that do not show HTML.
const toText = (html) =>
  html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, "$2 ($1)")
    .replace(/<(br|\/p|\/tr|\/h1|\/li)[^>]*>/g, "\n")
    .replace(/<\/td>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();

const bankRows = (req) => [
  ["Amount", money(req)],
  ["Bank", config.attestation.bank.bankName],
  ["Account name", config.attestation.bank.accountName],
  ["Account number", config.attestation.bank.accountNumber],
  ["Transfer remark", req.ref],
];

const templates = {
  received: (req) => ({
    to: req.client.email,
    subject: `We received your attestation request (${req.ref})`,
    html: layout({
      heading: "Your document has been received",
      intro: `Dear ${esc(req.client.name)}, thank you for using our online attestation service. ${esc(config.attorneyName)} will review your document and we will email you as soon as it is attested.`,
      rows: [["Reference", req.ref], ["Document", req.document.title], ["Pages", String(req.document.pages)]],
      button: { label: "Track your request", url: trackUrl(req) },
      footnote: "Keep this email: the link above is private to you and is how you will pay and download your attested copy.",
    }),
  }),

  newRequest: (req) => ({
    to: LAWYER_EMAIL,
    subject: `New attestation request: ${req.document.title} (${req.ref})`,
    html: layout({
      heading: "New document to attest",
      intro: `${esc(req.client.name)} has submitted a document for attestation.`,
      rows: [
        ["Reference", req.ref],
        ["Document", req.document.title],
        ["Pages", String(req.document.pages)],
        ["Client", req.client.name],
        ["Email", req.client.email],
        ["Phone", req.client.phone],
        ...(req.client.idNumber ? [["ID / Passport", req.client.idNumber]] : []),
        ...(req.document.notes ? [["Notes", req.document.notes]] : []),
      ],
      button: { label: "Review in dashboard", url: adminUrl(req) },
    }),
  }),

  approved: (req) =>
    Number(req.review.fee) > 0
      ? {
          to: req.client.email,
          subject: `Your document has been attested (${req.ref})`,
          html: layout({
            heading: "Your document is attested",
            intro: `Dear ${esc(req.client.name)}, ${esc(config.attorneyName)} has reviewed and attested <b>${esc(req.document.title)}</b>. To download your attested copy, please transfer the fee below, then upload your payment slip using the button.`,
            rows: bankRows(req),
            button: { label: "Upload slip & download", url: trackUrl(req) },
            footnote: `Please write your reference number <b>${esc(req.ref)}</b> as the transfer remark.`,
          }),
        }
      : templates.ready(req),

  ready: (req) => ({
    to: req.client.email,
    subject: `Your attested document is ready (${req.ref})`,
    html: layout({
      heading: "Your attested copy is ready",
      intro: `Dear ${esc(req.client.name)}, your attested copy of <b>${esc(req.document.title)}</b> is ready to download.`,
      rows: [["Reference", req.ref], ["Attested on", req.review.attestedDate]],
      button: { label: "Download attested copy", url: trackUrl(req) },
    }),
  }),

  rejected: (req) => ({
    to: req.client.email,
    subject: `Update on your attestation request (${req.ref})`,
    html: layout({
      heading: "We could not attest this document",
      intro: `Dear ${esc(req.client.name)}, after reviewing <b>${esc(req.document.title)}</b>, ${esc(config.attorneyName)} was unable to attest it.`,
      body: `<p style="margin:18px 0;padding:14px 16px;background:#faf7f2;border-left:3px solid #b3121b;font-size:14px;line-height:1.6">${esc(req.review.rejectReason).replace(/\n/g, "<br>")}</p>`,
      button: { label: "Submit a new request", url: `${PUBLIC_URL}/attest` },
      footnote: `Questions? Call ${esc(config.phone)} or reply to this email.`,
    }),
  }),

  slipUploaded: (req) => ({
    to: LAWYER_EMAIL,
    subject: `Payment slip uploaded (${req.ref})`,
    html: layout({
      heading: "A payment slip was uploaded",
      intro: config.attestation.requirePaymentVerification
        ? `${esc(req.client.name)} uploaded a payment slip. Please confirm the payment so they can download the attested copy.`
        : `${esc(req.client.name)} uploaded a payment slip and can now download the attested copy. Please check the slip against your bank statement.`,
      rows: [["Reference", req.ref], ["Document", req.document.title], ["Amount due", money(req)]],
      button: { label: "Check the payment", url: adminUrl(req) },
    }),
  }),

  paymentRejected: (req) => ({
    to: req.client.email,
    subject: `Payment could not be confirmed (${req.ref})`,
    html: layout({
      heading: "We could not confirm your payment",
      intro: `Dear ${esc(req.client.name)}, we were unable to match your payment slip for <b>${esc(req.document.title)}</b> to a payment.`,
      body: req.payment.rejectedNote
        ? `<p style="margin:18px 0;padding:14px 16px;background:#faf7f2;border-left:3px solid #b3121b;font-size:14px;line-height:1.6">${esc(req.payment.rejectedNote).replace(/\n/g, "<br>")}</p>`
        : "",
      rows: bankRows(req),
      button: { label: "Upload a new slip", url: trackUrl(req) },
    }),
  }),
};

async function deliver({ to, subject, html }) {
  if (!transport) {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const file = path.join(OUTBOX, `${Date.now()}-${slug}.html`);
    fs.writeFileSync(file, `<!-- To: ${to} | Subject: ${subject} -->\n${html}`);
    console.log(`[mail] SMTP not configured. Saved "${subject}" for ${to} to ${file}`);
    return { ok: false, mode: "outbox", error: "Email is not set up yet (SMTP settings missing)." };
  }
  try {
    await transport.sendMail({ from: FROM, to, subject, html, text: toText(html) });
    return { ok: true, mode: "smtp" };
  } catch (err) {
    console.error(`[mail] Could not send "${subject}" to ${to}:`, err.message);
    return { ok: false, mode: "smtp", error: err.message };
  }
}

// Builds and sends one of the templates; returns a log entry for the request's history.
async function send(type, req) {
  const message = templates[type](req);
  const result = await deliver(message);
  return { type, to: message.to, at: new Date().toISOString(), ...result };
}

module.exports = { send, PUBLIC_URL, LAWYER_EMAIL, trackUrl, isConfigured: () => Boolean(transport) };
