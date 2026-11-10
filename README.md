# HL Attorney at Law: Website & Online Attestation

The website of **HL Attorney at Law** (Uz. Hussain Layan, Attorney licence PL-2024/13), with an
online **document attestation** service:

1. The client uploads a document (PDF, JPG or PNG, several files allowed) at `/attest`.
2. The attorney reviews it in the dashboard at `/admin`, drags and resizes the stamp on each page,
   sets the fee and approves it (or declines it with a reason).
3. The client is emailed a private link with the fee and bank account details.
4. The client transfers the fee and uploads the payment slip on that page.
5. The attested PDF is unlocked for download. Anyone can check it with its reference number
   (for example `UZHL-STN22SJQU0`) at `/attest#verify`.

The stamp is printed on the PDF with the date of approval and the unique reference number.

## Run it

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # then edit .env
npm start                 # http://localhost:3000
```

Then:

1. Open `/admin` and sign in with the `ADMIN_PASSWORD` from `.env`.
2. Click **Stamp** and upload the prepared stamp image (transparent PNG). The stamp contains the
   attorney's signature, so it is stored only on the server and **never committed to git**.
3. Submit a test document at `/attest` and approve it.

## Settings

Everything is set in `.env` (see `.env.example`):

| Setting | What it does |
| --- | --- |
| `PUBLIC_URL` | The site's web address, used for links in emails |
| `ADMIN_PASSWORD`, `SESSION_SECRET` | Dashboard password and cookie signing secret |
| `LAWYER_EMAIL` | Where new-request and payment-slip alerts go |
| `SMTP_*`, `MAIL_FROM` | Outgoing email. Without them, emails are saved to `data/outbox/` and the dashboard shows the client link to share by WhatsApp instead |
| `FIRM_*` | Phone, WhatsApp number, email, address and office hours shown on the site |
| `BANK_*`, `ATTESTATION_FEE`, `ATTESTATION_CURRENCY` | The account clients pay into and the default fee |
| `REQUIRE_PAYMENT_VERIFICATION` | `false` (default): the download unlocks when the slip is uploaded. `true`: the attorney confirms the payment first |
| `DATA_DIR` | Node server only: where requests, uploaded files and the stamp are kept. **Must survive restarts** |

Firm name, attorney name and licence number are in `site.config.js`. If you replace the stamp
image with a different design, adjust the date/reference positions in `site.config.js` too.

## Deploying on EdgeOne Pages

The repository is ready for EdgeOne Pages (`edgeone.json`). Each push to GitHub deploys:

- the website pages, built into `dist/` by `npm run build`;
- the attestation API (`node-functions/api/[[default]].js`) as an EdgeOne Node Function;
- requests, documents, payment slips and the stamp, kept privately in **EdgeOne Pages Blob storage**.

After connecting the repository:

1. In the EdgeOne Pages project, open **Settings → Environment variables** and add at least
   `ADMIN_PASSWORD`, `PUBLIC_URL` (your site address, e.g. `https://hlattorney.mv`), `LAWYER_EMAIL`,
   the `SMTP_*` settings, `FIRM_PHONE`, `FIRM_WHATSAPP`, `FIRM_EMAIL`, the `BANK_*` details and
   `ATTESTATION_FEE`. Then redeploy: phone numbers and limits are written into the pages at build time.
2. Make sure Blob storage is available for the project (EdgeOne console, project **Storage** section).
3. Open `/admin`, sign in, and upload the stamp with the **Stamp** button.

On EdgeOne each document is limited to 5 MB in total, because EdgeOne functions can send at most
6 MB at a time. Large photos are shrunk in the browser before upload, so phone photos fit easily.

## Deploying on a Node.js server

Any host that runs Node.js and keeps files between restarts also works: a small VPS, or a platform
such as Render or Railway with a persistent disk mounted at `DATA_DIR`. Run `npm start`, put it behind
HTTPS and set `TRUST_PROXY=true` when it runs behind a proxy. Back up `DATA_DIR` regularly: it
contains the clients' documents and payment slips.

## Project layout

```
server.js            Runs the site as a Node.js server (files on disk)
node-functions/      EdgeOne Pages entry point for the API (Blob storage)
edgeone.json         EdgeOne build settings and page routes
scripts/build.js     Builds the static pages into dist/ for EdgeOne
site.config.js       Firm details, attestation options, stamp text positions
lib/                 App routes, storage, login, PDF stamping, email, file checks
public/              Website pages (index, attest, track, admin), styles and scripts
public/vendor/       pdf.js (Mozilla, Apache-2.0), used to preview documents in the dashboard
private/             Optional manual location for the stamp (PNG files here are git-ignored)
```
