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
| `DATA_DIR` | Where requests, uploaded files and the stamp are kept. **Must survive restarts** |

Firm name, attorney name and licence number are in `site.config.js`. If you replace the stamp
image with a different design, adjust the date/reference positions in `site.config.js` too.

## Deploying

Any host that runs Node.js and keeps files between restarts works: a small VPS, or a platform
such as Render or Railway with a persistent disk mounted at `DATA_DIR`. Put it behind HTTPS and set
`TRUST_PROXY=true` when it runs behind a proxy. Back up `DATA_DIR` regularly: it contains the
clients' documents and payment slips.

## Project layout

```
server.js            Web server and API
site.config.js       Firm details, attestation options, stamp text positions
lib/                 Storage, login, PDF stamping, email, file checks
public/              Website pages (index, attest, track, admin), styles and scripts
public/vendor/       pdf.js (Mozilla, Apache-2.0), used to preview documents in the dashboard
private/             Optional manual location for the stamp (PNG files here are git-ignored)
```
