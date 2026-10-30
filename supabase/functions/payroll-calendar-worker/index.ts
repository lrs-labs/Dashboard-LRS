import { createClient } from "npm:@supabase/supabase-js@2";
import "../../../payroll-core.js";
import { createPayrollCalendarRuntime } from "../payroll-api/payroll-calendar-runtime.mjs";
import { createPayrollBridgeEnvelope, PAYROLL_BRIDGE_ACTION, validatePayrollBridgeUrl } from "../payroll-api/hmac-bridge.mjs";
import { readRequestBodyLimited } from "../payroll-api/request-body-limit.mjs";

const core = (globalThis as any).PayrollCore;
const NO_STORE = "no-store, private, max-age=0";
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"
  } });
}
function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function readPayrollRows() {
  const url = Deno.env.get("GOOGLE_PAYROLL_READ_BRIDGE_URL") || "";
  const secret = Deno.env.get("GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET") || "";
  if (!validatePayrollBridgeUrl(url) || new TextEncoder().encode(secret).length < 32) throw new Error("payroll_source_not_configured");
  const envelope = await createPayrollBridgeEnvelope(secret, { action: PAYROLL_BRIDGE_ACTION });
  const response = await fetch(url, { method: "POST", redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(envelope) });
  if (!response.ok) throw new Error("payroll_source_unavailable");
  const payload = await response.json();
  if (payload?.ok !== true || payload?.schema !== 1 || payload?.action !== PAYROLL_BRIDGE_ACTION || !Array.isArray(payload.rows) || payload.rows.length > 20000) {
    throw new Error("payroll_source_response_invalid");
  }
  return payload.rows;
}

Deno.serve(async request => {
  if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const body = await readRequestBodyLimited(request, 1024);
  if (!body.ok) return reply({ error: "invalid_request" }, body.reason === "too_large" ? 413 : 400);
  if (body.text && body.text !== "{}") return reply({ error: "invalid_request" }, 400);
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supplied = request.headers.get("authorization") || "";
  if (!serviceRoleKey || !constantTimeEqual(supplied, `Bearer ${serviceRoleKey}`)) return reply({ error: "authentication_required" }, 401);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (!supabaseUrl) return reply({ error: "worker_not_configured" }, 503);
  try {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const runtime = createPayrollCalendarRuntime({ supabaseAdmin, core, env: {
      PAYROLL_CALENDAR_MARKS_ENABLED: Deno.env.get("PAYROLL_CALENDAR_MARKS_ENABLED") || "",
      PAYROLL_SHEET_WRITE_GUARD_VERIFIED: Deno.env.get("PAYROLL_SHEET_WRITE_GUARD_VERIFIED") || "",
      PAYROLL_CALENDAR_LOCAL_TIME: Deno.env.get("PAYROLL_CALENDAR_LOCAL_TIME") || "23:59",
      GOOGLE_OAUTH_CLIENT_ID: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "",
      GOOGLE_OAUTH_CLIENT_SECRET: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "",
      GOOGLE_OAUTH_REFRESH_TOKEN: Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN") || "",
      GOOGLE_PAYROLL_SOURCE_SPREADSHEET_ID: Deno.env.get("GOOGLE_PAYROLL_SOURCE_SPREADSHEET_ID") || "",
      GOOGLE_PAYROLL_SOURCE_TAB_ID: Deno.env.get("GOOGLE_PAYROLL_SOURCE_TAB_ID") || "",
      GOOGLE_PAYROLL_READ_BRIDGE_URL: Deno.env.get("GOOGLE_PAYROLL_READ_BRIDGE_URL") || "",
      GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET: Deno.env.get("GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET") || ""
    }, readPayrollRows });
    if (!runtime.enabled) return reply({ state: "disabled" }, 503);
    const result = await runtime.worker.run(new Date());
    return reply(result);
  } catch (_) { return reply({ error: "calendar_worker_unavailable" }, 503); }
});
