// EdgeOne Pages runs this file as a Node Function for every request under /api/.
// EdgeOne only recognises an Express app when this file itself creates it with express()
// and ends with `export default app`, so the site's API is mounted inside that app.
// Requests, documents and the stamp are kept in EdgeOne Pages Blob storage.
import express from "express";
import createApi from "../../lib/app";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(createApi({ driver: process.env.STORAGE_DRIVER || "blob", apiAtRoot: true, trustProxy: true }));

export default app;
