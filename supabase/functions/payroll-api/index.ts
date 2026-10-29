import { withSupabase } from "npm:@supabase/server@1";
import { isAllowedOrigin } from "./policy.mjs";
import { createPayrollBridgeEnvelope, DASHBOARD_BRIDGE_ACTION, PAYROLL_BRIDGE_ACTION, validatePayrollBridgeUrl } from "./hmac-bridge.mjs";
import { dispatchPayrollCommand } from "./command-router.mjs";
import { createPayrollWorkflowHandler } from "./workflow-http.mjs";
import { createSupabaseWorkflowStore } from "./supabase-workflow-store.mjs";

const ALLOWED_ORIGIN = Deno.env.get("APP_ORIGIN") || "";
const NO_STORE = "no-store, private, max-age=0";

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

async function accessForUser(ctx: { supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } }, userId: string) {
  const { data, error } = await ctx.supabaseAdmin.rpc("lrs_get_user_access", { p_user_id: userId });
  if (error) throw new Error("authorization_lookup_failed");
  return Array.isArray(data) ? data[0] || null : null;
}

async function readGoogleBridge(action: string) {
  const bridgeUrl = Deno.env.get("GOOGLE_PAYROLL_READ_BRIDGE_URL") || "";
  const bridgeSecret = Deno.env.get("GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET") || "";
  if (!bridgeUrl || !bridgeSecret) throw new Error("google_payroll_bridge_not_configured");
  if (!validatePayrollBridgeUrl(bridgeUrl)) throw new Error("google_payroll_bridge_url_invalid");
  const envelope = await createPayrollBridgeEnvelope(bridgeSecret, { action });
  const result = await fetch(bridgeUrl, {
    method: "POST",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(envelope)
  });
  if (!result.ok) throw new Error("google_payroll_bridge_read_failed");
  const payload = await result.json();
  if (payload?.ok !== true || payload?.schema !== 1 || payload?.action !== action || !Array.isArray(payload.rows)) {
    throw new Error("google_payroll_bridge_response_invalid");
  }
  if (action === DASHBOARD_BRIDGE_ACTION && !Array.isArray(payload.tabCells)) {
    throw new Error("google_payroll_bridge_response_invalid");
  }
  return payload;
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
    // Jobs and audit use server-only RPCs, but effects remain disabled until a
    // frozen Sheet snapshot and approved Google adapters are configured.
    const workflowStore = createSupabaseWorkflowStore(ctx.supabaseAdmin);
    const payrollWorkflow = createPayrollWorkflowHandler({ enabled: false, ...workflowStore });
    const rawBody = await request.text();
    if (rawBody.length > 1024) return response({ error: "request_too_large" }, 413);
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(rawBody); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "invalid_request" }, 400);
    }
    const dispatched = await dispatchPayrollCommand({
      body,
      access,
      actorId: user.id,
      workflow: payrollWorkflow,
      readPayroll: async () => {
        const payload = await readGoogleBridge(PAYROLL_BRIDGE_ACTION);
        if (payload.rows.length > 20000) throw new Error("payroll_payload_too_large");
        return { readAt: new Date().toISOString(), rows: payload.rows };
      },
      readDashboard: async () => {
        const payload = await readGoogleBridge(DASHBOARD_BRIDGE_ACTION);
        if (payload.rows.length > 20000 || payload.tabCells.length > 13000) throw new Error("dashboard_payload_too_large");
        // Dashboard, tabulator and calculator data are served together only to
        // active all-scope users until source rows have stable technician IDs.
        return { readAt: new Date().toISOString(), rows: payload.rows, tabCells: payload.tabCells };
      }
    });
    return response(dispatched.body, dispatched.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    const status = message === "google_payroll_bridge_not_configured" ? 503 : 500;
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
