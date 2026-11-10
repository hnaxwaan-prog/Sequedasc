// Settings the browser needs (window.SITE). The Node server serves them at /site-config.js;
// the EdgeOne build writes them to a static file.
const config = require("../site.config");

// EdgeOne functions can send at most 6 MB per response, so documents stay under 5 MB there.
function uploadLimits(driver) {
  const a = config.attestation;
  const cap = driver === "blob" ? 5 : Infinity;
  return { maxFiles: a.maxFiles, maxFileMB: Math.min(a.maxFileMB, cap), maxTotalMB: Math.min(a.maxTotalMB, cap) };
}

function publicConfig(driver) {
  return {
    firmName: config.firmName,
    attorneyName: config.attorneyName,
    licenseNo: config.licenseNo,
    phone: config.phone,
    whatsapp: config.whatsapp,
    email: config.email,
    address: config.address,
    hours: config.hours,
    attestation: { currency: config.attestation.currency, ...uploadLimits(driver) },
  };
}

const configScript = (driver) => `window.SITE = ${JSON.stringify(publicConfig(driver))};\n`;

module.exports = { uploadLimits, publicConfig, configScript };
