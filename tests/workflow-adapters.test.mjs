import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { archiveClosedInvoice, executeScheduledAdministrativeMarks, reconcileWorkflowAttempt, scheduledAdministrativeMarkDate, sendVerifiedInvoice } from "../supabase/functions/payroll-api/workflow-adapters.mjs";
import { makeWorkflowIdempotencyKey } from "../supabase/functions/payroll-api/workflow-idempotency.mjs";

const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic fixture");
const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
const archived = {
  state: "stored", fileId: "drive-file-fixture", revisionId: "drive-revision-fixture",
  sourceRevision: "sheet-version-7", snapshotId: "snapshot-2026-10-Q1-v1",
  technicianId: "tech-1", periodKey: "2026-10-Q1", pdfSha256
};
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
    async findUnresolvedEmail({ periodKey, technicianId }) {
      return [...rows.values()].filter(row => row.job_type === "invoice_email" && row.period_key === periodKey && row.technician_id === technicianId && ["queued", "running", "unknown", "needs_review"].includes(row.state));
    },
    async insertQueued(row) {
      if (row.job_type === "invoice_email" && [...rows.values()].some(existing => existing.job_type === "invoice_email" && existing.period_key === row.period_key && existing.technician_id === row.technician_id && ["queued", "running", "unknown", "needs_review"].includes(existing.state))) return false;
      if (rows.has(row.idempotency_key)) return false;
      rows.set(row.idempotency_key, { ...row, state: "queued" });
      return true;
    },
    async transition(key, state, patch = {}) { rows.set(key, { ...rows.get(key), ...patch, state }); }
  };
}
function fakeAudit() {
  const events = new Map();
  return { events, async record(event) { events.set(event.idempotencyKey, event); } };
}

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
  assert.equal(audit.events.size, 1);
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

test("email requires a verified archive and a preview bound to its PDF revision and recipient", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), sends = [], verifies = [];
  const recipientDirectory = { async resolve(id) { assert.equal(id, "tech-1"); return { technicianId: id, directoryId: "recipient-fixture-id", directoryVersion: "directory-v1", email: "fixture@example.invalid", active: true, verified: true }; } };
  const previewVerifier = { async verify(input) {
    verifies.push(input);
    return {
      approved: input.token === "fixture-signed-preview",
      deliveryAttemptId: "attempt-1",
      binding: {
        snapshotId: input.snapshotId, sourceRevision: input.sourceRevision, technicianId: input.technicianId,
        fileId: input.archive.fileId, revisionId: input.archive.revisionId, pdfSha256: input.archive.pdfSha256,
        recipientDirectoryId: input.recipient.directoryId, directoryVersion: input.recipient.directoryVersion,
        recipientEmail: input.recipient.email, actorId: input.actorId
      }
    };
  } };
  const mailer = { async send(input) { sends.push(input); return { messageId: "mail-fixture-1" }; } };
  const first = await sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf, recipientDirectory, previewVerifier, previewToken: "fixture-signed-preview", mailer, jobs, audit });
  const replay = await sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf, recipientDirectory, previewVerifier, previewToken: "fixture-signed-preview", mailer, jobs, audit });
  assert.equal(first.state, "succeeded");
  assert.equal(replay.replay, true);
  assert.equal(replay.result.messageId, "mail-fixture-1");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, "fixture@example.invalid");
  assert.equal("to" in verifies[0], false);
  assert.deepEqual(sends[0].archive, { fileId: archived.fileId, revisionId: archived.revisionId, pdfSha256 });
  assert.equal([...audit.events.values()][0].outcome, "succeeded");
});

test("email rejects unverified recipients, unapproved previews and unknown outcomes without resend", async () => {
  const recipientDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", directoryVersion: "directory-v1", email: "fixture@example.invalid", active: true, verified: false }; } };
  const noSend = { async send() { throw new Error("should_not_send"); } };
  const jobs = fakeJobs(), audit = fakeAudit();
  const previewVerifier = { async verify() { return { approved: false }; } };
  await assert.rejects(sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf, recipientDirectory, previewVerifier, previewToken: "bad", mailer: noSend, jobs, audit }), /verified_recipient_required/);

  const verifiedDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", directoryVersion: "directory-v1", email: "fixture@example.invalid", active: true, verified: true }; } };
  await assert.rejects(sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf, recipientDirectory: verifiedDirectory, previewVerifier, previewToken: "bad", mailer: noSend, jobs, audit }), /recipient_preview_approval_required/);

  const unknownJobs = fakeJobs();
  const unknownMailer = { async send() { return { outcomeUnknown: true }; } };
  const verifier = { async verify(input) { return { approved: true, deliveryAttemptId: "attempt-unknown", binding: {
    snapshotId: input.snapshotId, sourceRevision: input.sourceRevision, technicianId: input.technicianId,
    fileId: input.archive.fileId, revisionId: input.archive.revisionId, pdfSha256: input.archive.pdfSha256,
    recipientDirectoryId: input.recipient.directoryId, directoryVersion: input.recipient.directoryVersion,
    recipientEmail: input.recipient.email, actorId: input.actorId
  } }; } };
  const args = { snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf, recipientDirectory: verifiedDirectory, previewVerifier: verifier, previewToken: "fixture-signed-preview", mailer: unknownMailer, jobs: unknownJobs, audit };
  const unknown = await sendVerifiedInvoice(args);
  const retry = await sendVerifiedInvoice(args);
  assert.equal(unknown.state, "unknown");
  assert.equal(retry.state, "reconcile_required");
  assert.equal(retry.replay, true);
});

test("a new preview cannot create another email attempt while a prior outcome is unresolved", async () => {
  let sends = 0, deliveryAttempt = 0;
  const jobs = fakeJobs(), audit = fakeAudit();
  const recipientDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", directoryVersion: "directory-v1", email: "fixture@example.invalid", active: true, verified: true }; } };
  const previewVerifier = { async verify(input) { return { approved: true, deliveryAttemptId: `attempt-${++deliveryAttempt}`, binding: {
    snapshotId: input.snapshotId, sourceRevision: input.sourceRevision, technicianId: input.technicianId,
    fileId: input.archive.fileId, revisionId: input.archive.revisionId, pdfSha256: input.archive.pdfSha256,
    recipientDirectoryId: input.recipient.directoryId, directoryVersion: input.recipient.directoryVersion,
    recipientEmail: input.recipient.email, actorId: input.actorId
  } }; } };
  const mailer = { async send() { sends++; const error = new Error("outcome unknown"); error.outcomeUnknown = true; throw error; } };
  const args = { snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf,
    recipientDirectory, previewVerifier, previewToken: "fixture-token", mailer, jobs, audit };
  const first = await sendVerifiedInvoice(args);
  const second = await sendVerifiedInvoice(args);
  assert.equal(first.state, "unknown");
  assert.equal(second.state, "reconcile_required");
  assert.equal(sends, 1);
});

test("parallel different email previews share one unresolved technician-period claim", async () => {
  const jobs = fakeJobs(), audit = fakeAudit();
  let deliveryAttempt = 0, sends = 0, release, markProviderStarted;
  const providerStarted = new Promise(resolve => { markProviderStarted = resolve; });
  const recipientDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", directoryVersion: "directory-v1", email: "fixture@example.invalid", active: true, verified: true }; } };
  const previewVerifier = { async verify(input) { return { approved: true, deliveryAttemptId: `concurrent-${++deliveryAttempt}`, binding: {
    snapshotId: input.snapshotId, sourceRevision: input.sourceRevision, technicianId: input.technicianId,
    fileId: input.archive.fileId, revisionId: input.archive.revisionId, pdfSha256: input.archive.pdfSha256,
    recipientDirectoryId: input.recipient.directoryId, directoryVersion: input.recipient.directoryVersion,
    recipientEmail: input.recipient.email, actorId: input.actorId
  } }; } };
  const mailer = { async send() {
    sends++;
    markProviderStarted();
    return new Promise(resolve => { release = () => resolve({ messageId: "single-email-fixture" }); });
  } };
  const args = { snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf,
    recipientDirectory, previewVerifier, previewToken: "fixture-token", mailer, jobs, audit };
  const attempts = [sendVerifiedInvoice(args), sendVerifiedInvoice(args)];
  const failSafe = setTimeout(() => release?.(), 2_000);
  try {
    const started = await Promise.race([
      providerStarted.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 1_000))
    ]);
    assert.equal(started, true, "one request must reach the mocked email provider");
    const earlyResult = await Promise.race([
      ...attempts,
      new Promise(resolve => setTimeout(() => resolve(null), 1_000))
    ]);
    assert.equal(earlyResult?.state, "reconcile_required", "the competing request must be blocked before provider completion");
    assert.equal(sends, 1);
    release?.();
    const results = await Promise.all(attempts);
    assert.equal(results.filter(result => result.state === "succeeded").length, 1);
    assert.equal(results.filter(result => result.state === "reconcile_required").length, 1);
    assert.equal(sends, 1);
  } finally {
    release?.();
    clearTimeout(failSafe);
  }
});

test("email rejects changed PDFs, Drive revisions, and recipient directory versions", async () => {
  const recipientDirectory = { async resolve(id) { return { technicianId: id, directoryId: "recipient-id", directoryVersion: "directory-v2", email: "fixture@example.invalid", active: true, verified: true }; } };
  const mailer = { async send() { throw new Error("must_not_send"); } };
  const previewVerifier = { async verify(input) { return { approved: true, deliveryAttemptId: "attempt-bound",
    binding: { snapshotId: input.snapshotId, sourceRevision: input.sourceRevision, technicianId: input.technicianId,
      fileId: input.archive.fileId, revisionId: "old-revision", pdfSha256: input.archive.pdfSha256,
      recipientDirectoryId: input.recipient.directoryId, directoryVersion: "directory-v1", recipientEmail: input.recipient.email } }; } };
  const args = { snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf,
    recipientDirectory, mailer, previewVerifier, previewToken: "fixture-token", jobs: fakeJobs(), audit: fakeAudit() };
  await assert.rejects(sendVerifiedInvoice({ ...args, pdfBytes: new TextEncoder().encode("%PDF-different") }), /archived_pdf_content_mismatch/);
  await assert.rejects(sendVerifiedInvoice(args), /recipient_preview_approval_required/);
});

test("email preview approval is bound to the exact recipient address", async () => {
  let sends = 0;
  const recipientDirectory = { async resolve(id) {
    return { technicianId: id, directoryId: "directory-entry-1", directoryVersion: "directory-v4", email: "current@example.invalid", active: true, verified: true };
  } };
  const previewVerifier = { async verify(input) {
    return { approved: true, deliveryAttemptId: "attempt-email-bound", binding: {
      snapshotId: input.snapshotId, sourceRevision: input.sourceRevision, technicianId: input.technicianId,
      fileId: input.archive.fileId, revisionId: input.archive.revisionId, pdfSha256: input.archive.pdfSha256,
      recipientDirectoryId: input.recipient.directoryId, directoryVersion: input.recipient.directoryVersion,
      recipientEmail: "previous@example.invalid", actorId: input.actorId
    } };
  } };
  const mailer = { async send() { sends++; return { messageId: "must-not-send" }; } };
  await assert.rejects(sendVerifiedInvoice({ snapshot: snapshot(), technicianId: "tech-1", archivedFile: archived, pdfBytes: pdf,
    recipientDirectory, previewVerifier, previewToken: "fixture-token", mailer, jobs: fakeJobs(), audit: fakeAudit() }),
  /recipient_preview_approval_required/);
  assert.equal(sends, 0);
});

test("successful provider result is saved before audit and replay repairs audit without repeating the effect", async () => {
  const jobs = fakeJobs(), auditEvents = new Map(), calls = [];
  let failAudit = true;
  const audit = { async record(event) {
    if (failAudit) { failAudit = false; throw new Error("synthetic_audit_unavailable"); }
    auditEvents.set(event.idempotencyKey, event);
  } };
  const drive = {
    async findCurrentInvoice() { return null; },
    async createInvoice() { calls.push("create"); return { fileId: "file-1", revisionId: "revision-1" }; }
  };
  const args = { snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf,
    freshSourceRevision: "sheet-version-7", drive, jobs, audit };
  const first = await archiveClosedInvoice(args);
  assert.equal(first.state, "succeeded");
  assert.equal(first.auditPending, true);
  const replay = await archiveClosedInvoice(args);
  assert.equal(replay.state, "succeeded");
  assert.equal(replay.replay, true);
  assert.equal(replay.auditPending, false);
  assert.equal(replay.result.fileId, "file-1");
  assert.equal(calls.length, 1);
  assert.equal(auditEvents.size, 1);
});

test("provider success followed by result persistence failure stays reconcile-only", async () => {
  const jobs = fakeJobs(), calls = [], audit = fakeAudit();
  let failSucceededPersist = true;
  const baseTransition = jobs.transition.bind(jobs);
  jobs.transition = async (key, state, patch, options) => {
    if (state === "succeeded" && failSucceededPersist) { failSucceededPersist = false; throw new Error("synthetic_db_unavailable"); }
    return baseTransition(key, state, patch, options);
  };
  const drive = {
    async findCurrentInvoice() { return null; },
    async createInvoice() { calls.push("create"); return { fileId: "file-2", revisionId: "revision-2" }; }
  };
  const args = { snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf,
    freshSourceRevision: "sheet-version-7", drive, jobs, audit };
  const first = await archiveClosedInvoice(args);
  assert.equal(first.state, "reconcile_required");
  const replay = await archiveClosedInvoice(args);
  assert.equal(replay.state, "reconcile_required");
  assert.equal(calls.length, 1);
  const reconciled = await reconcileWorkflowAttempt({
    jobs, audit, idempotencyKey: first.idempotencyKey, jobType: "invoice_drive",
    requestDigest: jobs.rows.get(first.idempotencyKey).request_digest,
    lookupProviderResult: { async lookup() { return { state: "succeeded", result: { fileId: "file-2", revisionId: "revision-2" } }; } },
    auditEvent: { idempotencyKey: first.idempotencyKey, origin: "user", action: "invoice_drive", entityType: "invoice_drive", entityRef: "fixture", periodKey: "2026-10-Q1", outcome: "succeeded" }
  });
  assert.equal(reconciled.state, "succeeded");
  assert.equal(reconciled.reconciled, true);
  assert.equal(calls.length, 1);
});

test("parallel archive clicks claim one job and never call Drive twice", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), calls = [];
  let releaseProvider;
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  const drive = {
    async findCurrentInvoice() { return null; },
    async createInvoice() { calls.push("create"); await providerGate; return { fileId: "parallel-file", revisionId: "parallel-rev" }; }
  };
  const args = { snapshot: snapshot(), technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf,
    freshSourceRevision: "sheet-version-7", drive, jobs, audit };
  const firstPromise = archiveClosedInvoice(args);
  await new Promise(resolve => setTimeout(resolve, 0));
  const secondPromise = archiveClosedInvoice(args);
  const second = await secondPromise;
  assert.equal(second.state, "reconcile_required");
  releaseProvider();
  const first = await firstPromise;
  assert.equal(first.state, "succeeded");
  assert.equal(calls.length, 1);
});

test("an expired running lease is reconciled and never triggers an automatic second effect", async () => {
  const jobs = fakeJobs(), audit = fakeAudit(), calls = [];
  const data = snapshot();
  const identity = { jobType: "invoice_drive", periodKey: data.periodKey, technicianId: "tech-1", version: data.sourceRevision };
  const idempotencyKey = await makeWorkflowIdempotencyKey(identity);
  const digest = createHash("sha256").update(JSON.stringify({ ...identity, snapshotId: data.id, pdfSha256 })).digest("hex");
  jobs.rows.set(idempotencyKey, { idempotency_key: idempotencyKey, job_type: "invoice_drive", period_key: data.periodKey,
    request_digest: digest, state: "running", lease_expires_at: "2026-10-01T00:00:00.000Z" });
  const drive = { async findCurrentInvoice() { calls.push("find"); return null; }, async createInvoice() { calls.push("create"); return { fileId: "unexpected", revisionId: "unexpected" }; } };
  const result = await archiveClosedInvoice({ snapshot: data, technicianId: "tech-1", technicianName: "Fixture Tech", pdfBytes: pdf,
    freshSourceRevision: data.sourceRevision, drive, jobs, audit });
  assert.equal(result.state, "reconcile_required");
  assert.deepEqual(calls, []);
  const finalized = await reconcileWorkflowAttempt({ jobs, idempotencyKey, jobType: "invoice_drive", requestDigest: digest,
    lookupProviderResult: { async lookup() { return { state: "not_performed", definitive: true }; } } });
  assert.equal(finalized.state, "failed");
  assert.deepEqual(calls, []);
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
  assert.equal([...audit.events.values()][0].origin, "automatic-calendar-policy");
  assert.equal([...audit.events.values()][0].action, "calendar_mark");
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
