import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPayrollWorkflowHandler } from "../supabase/functions/payroll-api/workflow-http.mjs";
import { createInvoicePreviewTokenService } from "../supabase/functions/payroll-api/invoice-preview-token.mjs";
import { PAYROLL_API_BODY_LIMIT_BYTES, readRequestBodyLimited } from "../supabase/functions/payroll-api/request-body-limit.mjs";

const PDF = new TextEncoder().encode("%PDF-1.7\nsynthetic workflow fixture");
function closedSnapshot() {
  return { id: "snapshot-fixture-q1", state: "closed", frozen: true, periodKey: "2026-10-Q1",
    sourceRevision: "sheet-revision-fixture-1", frozenAt: "2026-10-16T14:00:00-04:00",
    lines: [{ assignmentId: "018f47a2-13a4-7b2c-8d2a-000000000001", technicianId: "tech-fixture-1", role: "TP", amount: 180, paidFlag: false }] };
}
function jobs() {
  const rows = new Map();
  return { async get(key) { return rows.get(key) || null; }, async findUnresolvedEmail({ periodKey, technicianId }) {
    return [...rows.values()].filter(row => row.job_type === "invoice_email" && row.period_key === periodKey && row.technician_id === technicianId && ["queued", "running", "unknown", "needs_review"].includes(row.state));
  }, async insertQueued(row) {
    if (row.job_type === "invoice_email" && [...rows.values()].some(existing => existing.job_type === "invoice_email" && existing.period_key === row.period_key && existing.technician_id === row.technician_id && ["queued", "running", "unknown", "needs_review"].includes(existing.state))) return false;
    if (rows.has(row.idempotency_key)) return false;
    rows.set(row.idempotency_key, { ...row, state: "queued" }); return true;
  }, async transition(key, state, patch = {}) { rows.set(key, { ...rows.get(key), ...patch, state }); } };
}
function setup(overrides = {}) {
  const calls = [];
  const jobStore = jobs();
  let archivedFile = null;
  let approvedBinding = null;
  let recipient = { technicianId: "tech-fixture-1", directoryId: "recipient-fixture-1", directoryVersion: "directory-v1", email: "tech@example.invalid", active: true, verified: true };
  const drive = {
    async findCurrentInvoice() { return archivedFile; },
    async getCurrentInvoice() { return archivedFile; },
    async createInvoice(input) { calls.push("drive-create"); archivedFile = { state: "stored", fileId: "drive-fixture-1", revisionId: "revision-v1",
      ...input.metadata, pdfSha256: createHash("sha256").update(input.content).digest("hex") }; return archivedFile; },
    async replacePreservingRevision(input) { calls.push("drive-replace"); archivedFile = { state: "stored", fileId: input.fileId, revisionId: "revision-v2",
      ...input.metadata, pdfSha256: createHash("sha256").update(input.content).digest("hex") }; return archivedFile; }
  };
  const recipientDirectory = { async resolve(id) { calls.push("recipient-read"); return recipient.technicianId === id ? { ...recipient } : null; } };
  const previewSigner = { async issue(binding) { approvedBinding = binding; return { token: "signed-preview-fixture", deliveryAttemptId: "delivery-attempt-fixture", expiresAt: "2026-10-29T05:00:00.000Z" }; } };
  const previewVerifier = { async verify(input) { return { approved: input.token === "signed-preview-fixture", deliveryAttemptId: "delivery-attempt-fixture", binding: approvedBinding }; } };
  const mailer = { async send() { calls.push("email-send"); return { messageId: "mail-fixture-1" }; } };
  const dependencies = {
    enabled: true,
    snapshotStore: { async getClosedSnapshot() { calls.push("snapshot-read"); return closedSnapshot(); } },
    sourceReader: { async getRevision() { return "sheet-revision-fixture-1"; } },
    identityResolver: async lines => lines.map(line => ({ state: "verified", assignmentId: line.assignmentId })),
    buildInvoice: async (snapshot, technicianId) => ({ periodKey: snapshot.periodKey, technician: "Fixture Tech", technicianId,
      lines: snapshot.lines.filter(line => line.technicianId === technicianId) }),
    renderPdf: async () => PDF,
    drive, recipientDirectory, previewSigner, previewVerifier, mailer, jobs: jobStore, audit: { async record() {} },
    actorId: "user-fixture-1", access: { is_active: true, role: "FINANCE", can_view_payroll: true,
      can_generate_invoice: true, can_send_invoice: true, can_mark_paid: false, scope_mode: "all", technician_ids: [] },
    ...overrides
  };
  return {
    handler: createPayrollWorkflowHandler(dependencies), calls, drive, recipientDirectory, jobs: jobStore,
    setRecipient(value) { recipient = value; }, getArchivedFile() { return archivedFile; }
  };
}

test("workflow API is disabled by default and performs no provider effects", async () => {
  const setupValue = setup({ enabled: false });
  const result = await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-only", periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "payroll_workflows_not_configured");
  assert.deepEqual(setupValue.calls, []);
});

test("disabled workflow configuration is not disclosed before authorization and technician scope checks", async () => {
  const setupValue = setup({ enabled: false, access: { is_active: true, role: "VIEWER", can_view_payroll: false,
    can_generate_invoice: false, can_send_invoice: false, can_mark_paid: false, scope_mode: "selected", technician_ids: [] } });
  const result = await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-only", periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "not_authorized");
  assert.deepEqual(setupValue.calls, []);
});

test("workflow API rejects client-supplied payroll facts, recipients, or provider identifiers", async () => {
  const setupValue = setup();
  const result = await setupValue.handler({ body: { action: "invoice.archive", periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture-q1",
    technicianId: "tech-fixture-1", amount: 999, email: "attacker@example.invalid", driveFileId: "client-file" } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid_request");
  assert.deepEqual(setupValue.calls, []);
});

test("scope is checked before reading any frozen snapshot", async () => {
  const setupValue = setup({ access: { is_active: true, role: "VIEWER", can_view_payroll: true, can_generate_invoice: false,
    can_send_invoice: false, scope_mode: "selected", technician_ids: ["other-tech"] } });
  const result = await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-only", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(result.status, 403);
  assert.deepEqual(setupValue.calls, []);
});

test("archive-and-send archives first and returns an exact-recipient confirmation without sending", async () => {
  const setupValue = setup();
  const result = await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-and-send", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "confirmation_required");
  assert.equal(result.body.drive.state, "stored");
  assert.equal(result.body.emailPreview.recipient, "tech@example.invalid");
  assert.equal(result.body.emailPreview.archive.fileId, setupValue.getArchivedFile().fileId);
  assert.deepEqual(setupValue.calls, ["snapshot-read", "drive-create", "recipient-read"]);
});

test("confirm-send rereads the frozen source and recipient and only sends the approved archive", async () => {
  const setupValue = setup();
  await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-and-send", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  const result = await setupValue.handler({ body: { action: "invoice.send-confirm", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1", previewToken: "signed-preview-fixture" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.email.state, "succeeded");
  assert.equal(result.body.email.result.messageId, "mail-fixture-1");
  assert.equal(setupValue.calls.filter(call => call === "drive-create" || call === "drive-replace").length, 1);
  assert.equal(setupValue.calls.filter(call => call === "email-send").length, 1);
});

test("the bounded API entry path accepts a complete signed confirmation body over the old 1024-byte cap", async () => {
  const tokens = createInvoicePreviewTokenService({
    secret: "synthetic-workflow-hmac-secret-for-test-only-32-bytes",
    now: () => Date.parse("2026-10-29T04:00:00.000Z"),
    createId: () => "delivery-fixture-long-token"
  });
  const setupValue = setup({ previewSigner: tokens, previewVerifier: tokens });
  setupValue.setRecipient({ technicianId: "tech-fixture-1", directoryId: "recipient-fixture-1",
    directoryVersion: `directory-v${"x".repeat(700)}`, email: "tech@example.invalid", active: true, verified: true });
  const archived = await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-and-send", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(archived.status, 200);

  const body = JSON.stringify({ action: "invoice.send-confirm", periodKey: "2026-10-Q1", snapshotId: "snapshot-fixture-q1",
    technicianId: "tech-fixture-1", previewToken: archived.body.emailPreview.token });
  const bytes = new TextEncoder().encode(body).byteLength;
  assert.ok(bytes > 1024, `full signed confirmation body was only ${bytes} bytes`);
  assert.ok(bytes < PAYROLL_API_BODY_LIMIT_BYTES);
  const read = await readRequestBodyLimited(new Request("https://app.example.test/api/payroll", {
    method: "POST", headers: { "content-type": "application/json" }, body
  }), PAYROLL_API_BODY_LIMIT_BYTES);
  assert.equal(read.ok, true);
  const sent = await setupValue.handler({ body: JSON.parse(read.text) });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.email.result.messageId, "mail-fixture-1");
});

test("send confirmation is rejected when the verified directory email changed after preview", async () => {
  const setupValue = setup();
  await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-and-send", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  setupValue.setRecipient({ technicianId: "tech-fixture-1", directoryId: "recipient-fixture-1", directoryVersion: "directory-v2",
    email: "changed@example.invalid", active: true, verified: true });
  const result = await setupValue.handler({ body: { action: "invoice.send-confirm", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1", previewToken: "signed-preview-fixture" } });
  assert.equal(result.status, 409);
  assert.notEqual(result.body.email?.state, "succeeded");
  assert.equal(setupValue.calls.includes("email-send"), false);
});

test("email-only retry uses the current archived PDF and never changes Drive", async () => {
  const setupValue = setup();
  await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-only", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  setupValue.calls.length = 0;
  const preview = await setupValue.handler({ body: { action: "invoice.retry-preview", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.emailPreview.recipient, "tech@example.invalid");
  const sent = await setupValue.handler({ body: { action: "invoice.retry-confirm", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1", previewToken: "signed-preview-fixture" } });
  assert.equal(sent.status, 200);
  assert.equal(setupValue.calls.filter(call => call.startsWith("drive-")).length, 0);
  assert.equal(setupValue.calls.filter(call => call === "email-send").length, 1);
});

test("a new email preview is blocked while the previous send response is uncertain", async () => {
  const setupValue = setup({ mailer: { async send() { setupValue.calls.push("email-send"); return { outcomeUnknown: true }; } } });
  const archive = await setupValue.handler({ body: { action: "invoice.archive", operation: "drive-and-send", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(archive.status, 200);
  const sent = await setupValue.handler({ body: { action: "invoice.send-confirm", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1", previewToken: "signed-preview-fixture" } });
  assert.equal(sent.status, 409);
  assert.equal(sent.body.state, "unknown");
  setupValue.calls.length = 0;
  const newPreview = await setupValue.handler({ body: { action: "invoice.retry-preview", periodKey: "2026-10-Q1",
    snapshotId: "snapshot-fixture-q1", technicianId: "tech-fixture-1" } });
  assert.equal(newPreview.status, 409);
  assert.equal(newPreview.body.error, "previous_email_outcome_requires_reconciliation");
  assert.equal(setupValue.calls.includes("email-send"), false);
});

