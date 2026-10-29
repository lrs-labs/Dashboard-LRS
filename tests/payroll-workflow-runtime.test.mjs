import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { createPayrollWorkflowRuntime } from "../supabase/functions/payroll-api/payroll-workflow-runtime.mjs";

test("workflow composition remains disabled by default and does not call providers", async () => {
  let calls = 0;
  const runtime = createPayrollWorkflowRuntime({ supabaseAdmin: { async rpc() { calls++; return { data: null, error: null }; } },
    core: Payroll, env: {}, readPayrollRows: async () => { calls++; return []; }, fetcher: async () => { calls++; } });
  assert.equal(runtime.driveEnabled, false);
  assert.equal(runtime.emailEnabled, false);
  assert.equal(runtime.tokenProviderConfigured, false);
  const result = await runtime.handler({ body: { action: "invoice.archive", operation: "drive-only", periodKey: "2026-10-Q1",
      snapshotId: "snapshot-fixture", technicianId: "tech-fixture-1" }, actorId: "user-fixture",
    access: { is_active: true, can_view_payroll: true, can_generate_invoice: true, scope_mode: "all" } });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "payroll_workflows_not_configured");
  assert.equal(calls, 0);
});
