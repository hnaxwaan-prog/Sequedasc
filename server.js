// Runs the website as a normal Node.js server (files are kept on disk in DATA_DIR).
// On EdgeOne Pages the API runs from node-functions/api/[[default]].js instead.
require("dotenv").config({ quiet: true });

const createApp = require("./lib/app");
const config = require("./site.config");
const auth = require("./lib/auth");
const mail = require("./lib/mailer");
const stamps = require("./lib/stamp");
const storage = require("./lib/storage");

const PORT = Number(process.env.PORT || 3000);
const app = createApp({ driver: process.env.STORAGE_DRIVER || "fs", site: true });

app.listen(PORT, async () => {
  console.log(`HL Attorney at Law is running on http://localhost:${PORT}`);
  if (!process.env.PUBLIC_URL) console.warn("[setup] PUBLIC_URL is not set: links in emails will point to localhost.");
  if (!auth.isConfigured()) console.warn("[setup] ADMIN_PASSWORD is not set (min. 8 characters): the attorney dashboard is locked.");
  if (!mail.isConfigured()) console.warn(`[setup] SMTP is not set up: emails are saved to ${storage.dir || "storage"}/outbox instead of being sent.`);
  if (!(await stamps.current().catch(() => null))) console.warn("[setup] No attestation stamp yet: upload it in the dashboard (Stamp button) before approving.");
  if (/^0+$/.test(config.attestation.bank.accountNumber)) console.warn("[setup] BANK_ACCOUNT_NUMBER is still the placeholder. Set the real account in .env.");
});
