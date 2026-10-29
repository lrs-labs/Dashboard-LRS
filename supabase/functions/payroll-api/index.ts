import { withSupabase } from "npm:@supabase/server@1";
import { authorizePayrollRead, isAllowedOrigin, mapPayrollRanges } from "./policy.mjs";

const ALLOWED_ORIGIN = Deno.env.get("APP_ORIGIN") || "";
const NO_STORE = "no-store, private, max-age=0";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SHEET_RANGES = ["REGISTRO_CASOS!B3:B", "REGISTRO_CASOS!F3:H", "REGISTRO_CASOS!J3:K", "REGISTRO_CASOS!P3:P", "REGISTRO_CASOS!U3:W", "REGISTRO_CASOS!X3:Z", "REGISTRO_CASOS!AF3:AH", "REGISTRO_CASOS!AI3:AI", "REGISTRO_CASOS!AO3:AO"];

function response(body: unknown, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": NO_STORE,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "vary": "Origin",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS"
    }
  });
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemBytes(pem: string) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function googleAccessToken(serviceAccount: { client_email: string; private_key: string }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(new TextEncoder().encode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: GOOGLE_TOKEN_URI,
    iat: issuedAt,
    exp: issuedAt + 300
  })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(serviceAccount.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const assertion = `${unsigned}.${base64url(signature)}`;
  const response = await fetch(GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  if (!response.ok) throw new Error("google_token_exchange_failed");
  const token = await response.json();
  if (typeof token.access_token !== "string") throw new Error("google_token_missing");
  return token.access_token as string;
}

async function accessForUser(ctx: { supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } }, userId: string) {
  const { data, error } = await ctx.supabaseAdmin.rpc("lrs_get_user_access", { p_user_id: userId });
  if (error) throw new Error("authorization_lookup_failed");
  return Array.isArray(data) ? data[0] || null : null;
}

async function readPayrollRows() {
  const sheetId = Deno.env.get("GOOGLE_PAYROLL_SHEET_ID");
  const serviceAccountJson = Deno.env.get("GOOGLE_SHEETS_READ_SERVICE_ACCOUNT_JSON");
  if (!sheetId || !serviceAccountJson) throw new Error("google_sheets_read_integration_not_configured");
  const serviceAccount = JSON.parse(serviceAccountJson);
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) throw new Error("google_sheets_read_credential_invalid");
  const accessToken = await googleAccessToken(serviceAccount);
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet`);
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
  for (const range of SHEET_RANGES) url.searchParams.append("ranges", range);
  const result = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!result.ok) throw new Error("google_sheets_read_failed");
  const payload = await result.json();
  return mapPayrollRanges(payload.valueRanges || []);
}

const authenticatedHandler = withSupabase({ auth: "user" }, async (request, ctx) => {
  const origin = request.headers.get("origin") || "";
  if (!isAllowedOrigin(ALLOWED_ORIGIN, origin)) return response({ error: "origin_not_allowed" }, 403, "null");
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 1024) return response({ error: "request_too_large" }, 413);

  try {
    const { data: userResult, error: userError } = await ctx.supabase.auth.getUser();
    const user = userResult?.user;
    if (userError || !user?.id || !(user.email_confirmed_at || user.confirmed_at)) return response({ error: "authentication_required" }, 401);
    const access = await accessForUser(ctx, user.id);
    const authorization = authorizePayrollRead(access);
    if (!authorization.ok) return response({ error: authorization.reason }, 403);

    const rawBody = await request.text();
    if (rawBody.length > 1024) return response({ error: "request_too_large" }, 413);
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(rawBody); } catch { body = null; }
    if (!body || body.action !== "payroll.read" || Object.keys(body).some(key => key !== "action")) {
      return response({ error: "invalid_request" }, 400);
    }

    const rows = await readPayrollRows();
    return response({ schema: 1, readAt: new Date().toISOString(), rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    const status = message === "google_sheets_read_integration_not_configured" ? 503 : 500;
    return response({ error: status === 503 ? message : "payroll_read_unavailable" }, status);
  }
});

Deno.serve(async request => {
  const origin = request.headers.get("origin") || "";
  if (!isAllowedOrigin(ALLOWED_ORIGIN, origin)) return response({ error: "origin_not_allowed" }, 403, "null");
  if (request.method === "OPTIONS") return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-headers": "authorization, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
      "vary": "Origin"
    }
  });
  const result = await authenticatedHandler(request);
  const headers = new Headers(result.headers);
  headers.set("access-control-allow-origin", ALLOWED_ORIGIN);
  headers.set("access-control-allow-headers", "authorization, apikey, content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("vary", "Origin");
  headers.set("cache-control", NO_STORE);
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
});
