import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { createPayrollCalendarRuntime } from "../supabase/functions/payroll-api/payroll-calendar-runtime.mjs";

test("scheduled payment worker is disabled until explicit server flags, source guard, Sheet identity and OAuth credentials exist", () => {
  let rpc = 0, network = 0;
  const dependencies = { supabaseAdmin: { async rpc() { rpc++; return { data: null, error: null }; } }, core: Payroll,
    readPayrollRows: async () => { network++; return []; }, fetcher: async () => { network++; } };
  const absent = createPayrollCalendarRuntime(dependencies);
  assert.equal(absent.enabled, false);
  assert.equal(absent.tokenProviderConfigured, false);
  assert.equal(absent.sourceGuardConfigured, false);
  assert.equal(rpc, 0);
  assert.equal(network, 0);

  const incomplete = createPayrollCalendarRuntime({ ...dependencies, env: {
    PAYROLL_CALENDAR_MARKS_ENABLED: "true", PAYROLL_SHEET_WRITE_GUARD_VERIFIED: "true",
    GOOGLE_PAYROLL_SOURCE_SPREADSHEET_ID: "synthetic-sheet-id", GOOGLE_PAYROLL_SOURCE_TAB_ID: "7",
    GOOGLE_OAUTH_CLIENT_ID: "fixture-client-id", GOOGLE_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "fixture-refresh-token"
  } });
  assert.equal(incomplete.enabled, false);
  assert.equal(incomplete.sourceBridgeConfigured, false);
  const complete = createPayrollCalendarRuntime({ ...dependencies, env: {
    PAYROLL_CALENDAR_MARKS_ENABLED: "true", PAYROLL_SHEET_WRITE_GUARD_VERIFIED: "true",
    GOOGLE_PAYROLL_SOURCE_SPREADSHEET_ID: "synthetic-sheet-id", GOOGLE_PAYROLL_SOURCE_TAB_ID: "7",
    GOOGLE_PAYROLL_READ_BRIDGE_URL: "https://script.google.com/macros/s/synthetic-deployment/exec",
    GOOGLE_PAYROLL_BRIDGE_HMAC_SECRET: "synthetic-secret-long-enough-for-tests-only",
    GOOGLE_OAUTH_CLIENT_ID: "fixture-client-id", GOOGLE_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "fixture-refresh-token"
  } });
  assert.equal(complete.enabled, true);
  assert.equal(complete.sourceBridgeConfigured, true);
  assert.equal(rpc, 0);
  assert.equal(network, 0, "composition alone does not read Sheets or perform a write");
});
