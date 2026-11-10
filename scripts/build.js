// Builds the static website for EdgeOne Pages into dist/.
// (The API is deployed separately by EdgeOne from node-functions/.)
const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ quiet: true });
} catch {
  // dotenv is optional here: on EdgeOne the settings come from the project's environment variables.
}
const { configScript } = require("../lib/public-config");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), dist, { recursive: true });
fs.writeFileSync(path.join(dist, "site-config.js"), configScript("blob"));
console.log("Static site built into dist/");
