// Small in-memory rate limiter (per IP address) for public endpoints.
const { HttpError } = require("./errors");

const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.reset < now) buckets.delete(key);
}, 60_000).unref();

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset < now) buckets.set(key, (bucket = { count: 0, reset: now + windowMs }));
    if (++bucket.count > max) return next(new HttpError(429, "Too many attempts. Please wait a little and try again."));
    next();
  };
}

module.exports = { rateLimit };
