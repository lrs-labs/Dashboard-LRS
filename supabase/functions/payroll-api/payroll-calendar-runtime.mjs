import { createSupabasePayrollSnapshotStorage } from "./supabase-snapshot-recipient-store.mjs";
import { createSupabaseWorkflowStore } from "./supabase-workflow-store.mjs";
import { createGoogleRefreshTokenProvider } from "./google-oauth-token.mjs";
import { createGoogleSheetsPaidFlagWriter } from "./google-sheets-paid-flag-writer.mjs";
import { createPayrollCalendarPaymentWorker } from "./calendar-payment-worker.mjs";
import { computePeriodSourceRevision } from "./payroll-source-projection.mjs";
import { validatePayrollBridgeUrl } from "./hmac-bridge.mjs";

/** Scheduled payment state changes are disabled unless every server-side guard is explicitly configured. */
export function createPayrollCalendarRuntime({ supabaseAdmin, core, env = {}, readPayrollRows,
  fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  if (typeof supabaseAdmin?.rpc !== "function" || !core?.buildAssignments || typeof readPayrollRows !== "function") {
    throw new TypeError("payroll_calendar_runtime_dependencies_required");
  }
  const tokenProvider = createGoogleRefreshTokenProvider({ config: {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN
  }, fetcher, now });
  const sheetId = env.GOOGLE_PAYROLL_SOURCE_SPREADSHEET_ID || "";
  const sheetTabId = Number(env.GOOGLE_PAYROLL_SOURCE_TAB_ID);
  const sourceBridgeConfigured = validatePayrollBridgeUrl(env.GOOGLE_PAYROLL_READ_BRIDGE_URL || "") &&
    typeof env.GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET === "string" && new TextEncoder().encode(env.GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET).length >= 32;
  const configured = env.PAYROLL_CALENDAR_MARKS_ENABLED === "true" && tokenProvider.configured && !!sheetId &&
    Number.isSafeInteger(sheetTabId) && sheetTabId >= 0 && env.PAYROLL_SHEET_WRITE_GUARD_VERIFIED === "true" && sourceBridgeConfigured;
  const writer = createGoogleSheetsPaidFlagWriter({ core, fetcher, config: {
    enabled: configured, writeEnabled: configured, sourceWriteGuardVerified: configured,
    spreadsheetId: sheetId, sourceTabId: sheetTabId, sourceTabName: "REGISTRO_CASOS",
    getAccessToken: () => tokenProvider.getAccessToken()
  } });
  const snapshotStore = createSupabasePayrollSnapshotStorage(supabaseAdmin);
  const { jobs, audit } = createSupabaseWorkflowStore(supabaseAdmin);
  const sourceReader = Object.freeze({ async getPeriodRevision({ periodKey }) {
    return computePeriodSourceRevision(await readPayrollRows(), periodKey, core);
  } });
  const worker = createPayrollCalendarPaymentWorker({ enabled: configured, snapshotStore: {
    listClosedSnapshots: async () => {
      const rows = await snapshotStore.listClosed();
      return rows;
    }
  }, sourceReader, writer, jobs, audit, executionLocalTime: env.PAYROLL_CALENDAR_LOCAL_TIME || "23:59" });
  return Object.freeze({ worker, enabled: configured, tokenProviderConfigured: tokenProvider.configured,
    sourceGuardConfigured: env.PAYROLL_SHEET_WRITE_GUARD_VERIFIED === "true", sourceBridgeConfigured });
}
