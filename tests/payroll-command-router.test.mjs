import test from "node:test";
import assert from "node:assert/strict";
import { classifyPayrollCommand, dispatchPayrollCommand } from "../supabase/functions/payroll-api/command-router.mjs";

const allAccess = { is_active: true, can_view_payroll: true, can_view_dashboard: true, can_generate_invoice: true, can_send_invoice: true, scope_mode: "all", technician_ids: [] };

test("only known read and invoice workflow actions are routable", () => {
  assert.deepEqual(classifyPayrollCommand({ action: "payroll.read" }), { ok: true, kind: "read", action: "payroll.read" });
  assert.deepEqual(classifyPayrollCommand({ action: "invoice.archive", operation: "drive-only" }), { ok: true, kind: "workflow", action: "invoice.archive" });
  assert.equal(classifyPayrollCommand({ action: "payroll.read", email: "attacker@example.invalid" }).ok, false);
  assert.equal(classifyPayrollCommand({ action: "sheet.write" }).ok, false);
  assert.equal(classifyPayrollCommand([]).ok, false);
});

test("read commands apply the matching capability before executing the reader", async () => {
  let payrollReads = 0;
  const denied = await dispatchPayrollCommand({ body: { action: "payroll.read" }, access: { ...allAccess, can_view_payroll: false }, readPayroll: async () => { payrollReads++; return { rows: [] }; } });
  assert.equal(denied.status, 403);
  assert.equal(payrollReads, 0);
  const allowed = await dispatchPayrollCommand({ body: { action: "payroll.read" }, access: allAccess, readPayroll: async () => ({ rows: [{ date: "2026-10-01" }] }) });
  assert.deepEqual(allowed, { status: 200, body: { schema: 1, rows: [{ date: "2026-10-01" }] } });
});

test("workflow commands reach only the server handler with verified actor and access context", async () => {
  const calls = [];
  const result = await dispatchPayrollCommand({ body: { action: "invoice.archive", operation: "drive-only", periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture", technicianId: "tech-fixture" }, access: allAccess, actorId: "user-fixture",
    workflow: async input => { calls.push(input); return { status: 503, body: { schema: 1, error: "payroll_workflows_not_configured" } }; } });
  assert.equal(result.status, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorId, "user-fixture");
  assert.equal(calls[0].body.technicianId, "tech-fixture");
});

test("workflow command routing has no provider fallback when no private handler exists", async () => {
  const result = await dispatchPayrollCommand({ body: { action: "invoice.send-confirm" }, access: allAccess });
  assert.deepEqual(result, { status: 503, body: { error: "payroll_workflows_not_configured" } });
});
