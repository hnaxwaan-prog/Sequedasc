// Firm details used on the website, in emails, on the stamp and on the payment page.
// Edit the values below (or set the matching environment variable in .env).
const env = (key, fallback) => (process.env[key] ?? "").trim() || fallback;

module.exports = {
  firmName: "HL Attorney at Law",
  attorneyName: "Uz. Hussain Layan",
  licenseNo: "PL-2024/13",

  phone: env("FIRM_PHONE", "+960 000 0000"),
  whatsapp: env("FIRM_WHATSAPP", "9600000000"), // digits only, with country code
  email: env("FIRM_EMAIL", "info@hlattorney.mv"),
  address: env("FIRM_ADDRESS", "Malé, Republic of Maldives"),
  hours: env("FIRM_HOURS", "Sunday – Thursday, 9:00 AM – 5:00 PM"),
  timezone: env("FIRM_TIMEZONE", "Indian/Maldives"),

  attestation: {
    currency: env("ATTESTATION_CURRENCY", "MVR"),
    // Fee pre-filled for the attorney when approving. It can be changed per request.
    defaultFee: Number(env("ATTESTATION_FEE", "0")),
    // When true, the client can download only after the attorney confirms the payment slip.
    // When false (default), the download unlocks as soon as the slip is uploaded.
    requirePaymentVerification: env("REQUIRE_PAYMENT_VERIFICATION", "false") === "true",
    bank: {
      bankName: env("BANK_NAME", "Bank of Maldives"),
      accountName: env("BANK_ACCOUNT_NAME", "HL Attorney at Law"),
      accountNumber: env("BANK_ACCOUNT_NUMBER", "0000000000000"),
    },
    maxFiles: 10,
    maxFileMB: 15,
    maxTotalMB: 40,
  },

  // Where the date and reference number are printed on private/stamp.png,
  // in pixels of that image. Only change these if you replace the stamp image.
  stamp: {
    width: 1737,
    height: 1125,
    color: [219, 0, 0],
    date: { centerX: 1415, baseline: 888, maxWidth: 330, size: 50 },
    ref: { right: 1640, baseline: 1011, maxWidth: 520, size: 44 },
  },
};
