// EdgeOne Pages runs this file as a Node Function for every request under /api/.
// Requests, documents and the stamp are kept in EdgeOne Pages Blob storage.
import createApp from "../../lib/app.js";

export default createApp({ driver: process.env.STORAGE_DRIVER || "blob", apiAtRoot: true, trustProxy: true });
