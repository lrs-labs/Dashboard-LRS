import test from "node:test";
import assert from "node:assert/strict";
import { archiveClosedInvoice, executeScheduledAdministrativeMarks, scheduledAdministrativeMarkDate, sendVerifiedInvoice } from "../supabase/functions/payroll-api/workflow-adapters.mjs";

const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic fixture");
function snapshot(overrides = {}) {
  return {
    id: "snapshot-2026-10-Q1-v1", state: "closed", frozen: true, periodKey: "2026-10-Q1",
    sourceRevision: "sheet-version-7", frozenAt: "2026-10-16T14:00:00-04:00",
    lines: [{ assignmentId: "assignment-1", technicianId: "tech-1", role: "TP", amount: 180, paidFlag: false }],
    ...overrides
  };
}
function fakeJobs() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.get(key) || null; },
    async insertQueued(row) {
      if (rows.has(row.idempotency_key)) return false;
      rows.set(row.idempotency_key, { ...row, state: "queued" });
      return true;
    },
    async transition(key, state, patch = {}) { rows.set(key, { ...rows.get(key), ...patch, state }); }
  };
}
function fakeAudit() { const events = []; return { events, async record(event) { events.push(event); } }; }

 test("invoice archive creates one current file in the approved folder path and replays idempotently", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), calls = [];
  const drive = {
    async findCurrentInvoice(input) { calls.push(["find", input]); return null; },
    async createInvoice(input) { calls.push(["create", input]); return { fileId: "drive-fixture-1", revisionId: "rev-1" }; }
  };
  const first = await archiveClosedInvoice({ snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf, freshSourceRevision: "sheet-version-7", drive, jobs, audit });
  const second = await archiveClosedInvoice({ snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf, freshSourceRevision: "sheet-version-7", drive, jobs, audit });
  assert.equal(first.state, "succeeded");
  assert.equal(first.result.folderPath, "NOMINAS/2026/OCTUBRE/Fixture Tech");
  assert.equal(first.result.fileName, "Fixture Tech - 1RA QUINCENA 2026-10.pdf");
  assert.equal(second.state, "succeeded");
  assert.equal(second.replay, true);
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
  assert.equal(audit.events.length, 1);
  const secondHalf = await archiveClosedInvoice({
    snapshot: snapshot({ periodKey: "2026-10-Q2", frozenAt: "2026-11-01T12:00:00-04:00" }),
    technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf,
    freshSourceRevision: "sheet-version-7", drive, jobs: fakeJobs(), audit: fakeAudit()
  });
  assert.equal(secondHalf.result.fileName, "Fixture Tech - 2DA QUINCENA 2026-10.pdf");
});

test("invoice regeneration keeps the Drive file identity and requires a fresh matching Sheet version", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), replaces = [];
  const drive = {
    async findCurrentInvoice() { return { fileId: "same-file-id", revisionId: "rev-old" }; },
    async replacePreservingRevision(input) { replaces.push(input); return { fileId: input.fileId, revisionId: "rev-new" }; }
  };
  const result = await archiveClosedInvoice({ snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf, freshSourceRevision: "sheet-version-7", drive, jobs, audit });
  assert.equal(result.state, "succeeded");
  assert.equal(result.result.fileId, "same-file-id");
  assert.equal(result.result.replaced, true);
  assert.equal(replaces[0].expectedRevisionId, "rev-old");
  await assert.rejects(archiveClosedInvoice({ snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf, freshSourceRevision: "changed-after-close", drive, jobs: fakeJobs(), audit: fakeAudit() }), /source_changed_since_snapshot_review_required/);
});

test("invoice archive refuses open snapshots, unsafe PDF input and technicians outside the frozen snapshot", async () => {
  const noop = { async get() { return null; }, async insertQueued() { return true; }, async transition() {} };
  const audit = { async record() {} };
  const drive = { async findCurrentInvoice() { throw new Error("must_not_read_drive"); } };
  await assert.rejects(archiveClosedInvoice({ snapshot: snapshot({ state: "open" }), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf, freshSourceRevision: "sheet-version-7", drive, jobs: noop, audit }), /frozen_closed_snapshot_required/);
  await assert.rejects(archiveClosedInvoice({ snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: new TextEncoder().encode("html"), freshSourceRevision: "sheet-version-7", drive, jobs: noop, audit }), /pdf_bytes_required/);
  await assert.rejects(archiveClosedInvoice({ snapshot: snapshot(), technicianId: "tech-2", technicianName: "Fixture Tech", pdfBytes: pdf, freshSourceRevision: "sheet-version-7", drive, jobs: noop, audit }), /technician_not_in_snapshot/);
});

test("email uses only a verified server directory recipient and requires a matching preview token", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), sends = [], verifies = [];
  const recipientDirectory = { async resolve(id) { assert.equal(id, "tech-1"); return { technicianId: id, directoryId: "recipient-fixture-id", email: "fixture@example.invalid", active: true, verified: true }; } };
  const previewVerifier = { async verify(input) { verifies.push(input); return { approved: input.token === "fixture-signed-preview" }; } };
  const mailer = { async send(input) { sends.push(input); return { messageId: "mail-fixture-1" }; } };
  const first = await sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", deliveryAttemptId: "attempt-1", pdfBytes: pdf, recipientDirectory, previewVerifier, previewToken: "fixture-signed-preview", mailer, jobs, audit });
  const replay = await sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", deliveryAttemptId: "attempt-1", pdfBytes: pdf, recipientDirectory, previewVerifier, previewToken: "fixture-signed-preview", mailer, jobs, audit });
  assert.equal(first.state, "succeeded");
  assert.equal(replay.replay, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, "fixture@example.invalid");
  assert.equal("to" in verifies[0], false);
  assert.equal(audit.events[0].outcome, "succeeded");
});

test("email rejects unverified recipients, unapproved previews and unknown outcomes without resend", async () => {
  const recipientDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", email: "fixture@example.invalid", active: true, verified: false }; } };
  const noSend = { async send() { throw new Error("should_not_send"); } };
  const jobs = fakeJobs(), audit = fakeAudit();
  const previewVerifier = { async verify() { return { approved: false }; } };
  await assert.rejects(sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", deliveryAttemptId: "attempt-a", pdfBytes: pdf, recipientDirectory, previewVerifier, previewToken: "bad", mailer: noSend, jobs, audit }), /verified_recipient_required/);

  const verifiedDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", email: "fixture@example.invalid", active: true, verified: true }; } };
  await assert.rejects(sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", deliveryAttemptId: "attempt-a", pdfBytes: pdf, recipientDirectory: verifiedDirectory, previewVerifier, previewToken: "bad", mailer: noSend, jobs, audit }), /recipient_preview_approval_required/);

  const unknownJobs = fakeJobs();
  const unknownMailer = { async send() { return { outcomeUnknown: true }; } };
  const verifier = { async verify() { return { approved: true }; } };
  const args = { snapshot: snapshot(), technicianId: "tech-1", deliveryAttemptId: "attempt-unknown", pdfBytes: pdf, recipientDirectory: verifiedDirectory, previewVerifier: verifier, previewToken: "fixture-signed-preview", mailer: unknownMailer, jobs: unknownJobs, audit };
  const unknown = await sendVerifiedInvoice(args);
  const retry = await sendVerifiedInvoice(args);
  assert.equal(unknown.state, "unknown");
  assert.equal(retry.state, "unknown");
  assert.equal(retry.replay, true);
});

test("administrative calendar maps Q1 to day 18 and Q2 to day 3 across year boundary", () => {
  assert.equal(scheduledAdministrativeMarkDate("2026-10-Q1"), "2026-10-18");
  assert.equal(scheduledAdministrativeMarkDate("2026-10-Q2"), "2026-11-03");
  assert.equal(scheduledAdministrativeMarkDate("2026-12-Q2"), "2027-01-03");
  assert.throws(() => scheduledAdministrativeMarkDate("2026-13-Q1"), /invalid_period/);
});

test("calendar adapter writes only positive, pending, stable assignments on exact New York date", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), writes = [];
  const data = snapshot({ periodKey: "2026-10-Q1", lines: [
    { assignmentId: "a-1", technicianId: "tech-1", role: "TP", amount: 180, paidFlag: false },
    { assignmentId: "a-2", technicianId: "tech-1", role: "TA1", amount: 130, paidFlag: true },
    { assignmentId: "a-3", technicianId: "tech-1", role: "TA2", amount: 0, paidFlag: false }
  ] });
  const writer = { async setPaidFlagByStableAssignmentId(input) { writes.push(input); return { updated: true }; } };
  const now = new Date("2026-10-18T13:00:00.000Z");
  const result = await executeScheduledAdministrativeMarks({ snapshot: data, now, writer, jobs, audit });
  assert.equal(result.state, "succeeded");
  assert.equal(result.changed, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual({ id: writes[0].assignmentId, role: writes[0].role, from: writes[0].expectedPaidFlag, to: writes[0].paidFlag }, { id: "a-1", role: "TP", from: false, to: true });
  assert.equal(writes[0].dueDate, "2026-10-18");
  assert.equal(audit.events[0].origin, "automatic-calendar-policy");
  assert.equal(audit.events[0].action, "calendar_mark");
  const replay = await executeScheduledAdministrativeMarks({ snapshot: data, now, writer, jobs, audit });
  assert.equal(replay.state, "succeeded");
  assert.equal(writes.length, 1);
});

test("calendar adapter never marks early, late, unknown, retroactive or unstable work", async () => {
  let writes = 0;
  const writer = { async setPaidFlagByStableAssignmentId() { writes++; return { updated: true }; } };
  const base = { writer, jobs: fakeJobs(), audit: fakeAudit() };
  const early = await executeScheduledAdministrativeMarks({ ...base, snapshot: snapshot(), now: new Date("2026-10-17T15:00:00Z") });
  assert.equal(early.state, "not_due");
  const unknown = await executeScheduledAdministrativeMarks({ ...base, snapshot: snapshot({ lines: [{ assignmentId: "a", technicianId: "tech-1", role: "TP", amount: 10, paidFlag: null }] }), now: new Date("2026-10-18T15:00:00Z") });
  assert.equal(unknown.state, "needs_review");
  assert.equal(unknown.reason, "payment_flag_unknown");
  const late = await executeScheduledAdministrativeMarks({ ...base, snapshot: snapshot({ frozenAt: "2026-10-19T15:00:00Z" }), now: new Date("2026-10-18T15:00:00Z") });
  assert.equal(late.state, "needs_review");
  assert.equal(late.reason, "snapshot_closed_after_due_date");
  await assert.rejects(executeScheduledAdministrativeMarks({ ...base, snapshot: snapshot({ lines: [{ assignmentId: "", technicianId: "tech-1", role: "TP", amount: 10, paidFlag: false }] }), now: new Date("2026-10-18T15:00:00Z") }), /invalid_snapshot_assignment/);
  assert.equal(writes, 0);
});
