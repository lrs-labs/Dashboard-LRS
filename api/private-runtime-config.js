function isSupabasePublishableKey(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4096 || /\s/.test(value)) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.role === "anon"; }
  catch (_) { return false; }
}

function originAllowed(request, allowedOrigin) {
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin && suppliedOrigin !== allowedOrigin) return false;
  const forwardedHost = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  try {
    const allowed = new URL(allowedOrigin);
    return forwardedProtocol === "https" && forwardedHost === allowed.host && (!suppliedOrigin || suppliedOrigin === allowed.origin);
  } catch (_) { return false; }
}

function createHandler(env = process.env) {
  return (request, response) => {
    const allowedOrigin = env.APP_ORIGIN || "";
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store, private, max-age=0");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("vary", "Origin");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("allow", "GET");
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!originAllowed(request, allowedOrigin)) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }
    const supabaseUrl = env.SUPABASE_URL || "";
    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || "";
    try {
      const url = new URL(supabaseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !isSupabasePublishableKey(publishableKey)) throw new Error("invalid_runtime_config");
      response.statusCode = 200;
      response.end(JSON.stringify({ supabaseUrl: url.origin, publishableKey, allowedOrigin }));
    } catch (_) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "runtime_not_configured" }));
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
