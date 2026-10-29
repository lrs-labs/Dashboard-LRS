import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { buildClosedPayrollSnapshot } from "../supabase/functions/payroll-api/payroll-snapshot-store.mjs";
import { createPayrollCalendarPaymentWorker } from "../supabase/functions/payroll-api/calendar-payment-worker.mjs";
import { projectPayrollRowsWithAssignmentIds } from "../supabase/functions/payroll-api/payroll-source-projection.mjs";

const source = { date: "2026-10-08", period: "1RA QUINCENA", category: "EXTERNO", client: "Fixture Client", project: "Fixture Project",
  activity: "MITIGATION", caseName: "CASE-7", status: "COMPLETED", tp: "Fixture Tech", ta1: "", ta2: "", amountTP: 180,
  amountTA1: 0, amountTA2: 0, paidTP: false, paidTA1: false, paidTA2: false, report: "YES" };
const roster = [{ technicianId: "tech-fixture-1", displayName: "Fixture Tech", active: true }];
async function snap(overrides = {}) {
  const row = { ...source, ...(overrides.source || {}) };
  const records = new Map();
  const identityStore = { async findByIdentityHash(key) { return records.get(key) || null; }, async createPending(record) {
    records.set(record.identityKeyHash, { ...record, state: "pending_review" }); return { inserted: true };
  } };
  const createId = () => "018f47a2-13a4-7b2c-8d2a-1afc808d1001";
  await projectPayrollRowsWithAssignmentIds([row], { core: Payroll, roster, identityStore, createId });
  for (const record of records.values()) { record.state = "verified"; record.sheetMetadataId = 321; }
  const projected = await projectPayrollRowsWithAssignmentIds([row], { core: Payroll, roster, identityStore, createId });
  const periodKey = projected.sourceRevisions[Object.keys(projected.sourceRevisions)[0]] && Payroll.periodKey(
    Number(Payroll.parseDate(row.date).slice(0, 4)), Number(Payroll.parseDate(row.date).slice(5, 7)), Payroll.parseHalf(row.period));
  const closedAt = overrides.closedAt || "2026-10-15T23:59:00-04:00";
  const frozenAt = overrides.frozenAt || closedAt;
  return buildClosedPayrollSnapshot({
    periodKey, sourceRevision: projected.sourceRevisions[periodKey], rows: projected.rows, core: Payroll,
    closedAt, frozenAt, snapshotId: overrides.snapshotId || "018f47a2-13a4-7b2c-8d2a-1afc808d1002"
  });
}
async function snapWithTwoAssignments() {
  const rows = [source, { ...source, caseName: "CASE-8", project: "Fixture Project 2", client: "Fixture Client 2", tp: "Fixture Tech 2" }];
  const records = new Map();
  const identityStore = { async findByIdentityHash(key) { return records.get(key) || null; }, async createPending(record) {
    records.set(record.identityKeyHash, { ...record, state: "pending_review" }); return { inserted: true };
  } };
  let nextId = 1;
  const createId = () => `018f47a2-13a4-7b2c-8d2a-1afc808d10${String(nextId++).padStart(2, "0")}`;
  const roster = [{ technicianId: "tech-fixture-1", displayName: "Fixture Tech", active: true },
    { technicianId: "tech-fixture-2", displayName: "Fixture Tech 2", active: true }];
  await projectPayrollRowsWithAssignmentIds(rows, { core: Payroll, roster, identityStore, createId });
  let metadataId = 321;
  for (const record of records.values()) { record.state = "verified"; record.sheetMetadataId = metadataId++; }
  const projected = await projectPayrollRowsWithAssignmentIds(rows, { core: Payroll, roster, identityStore, createId });
  const periodKey = projected.sourceRevisions["2026-10-Q1"] && "2026-10-Q1";
  return buildClosedPayrollSnapshot({ periodKey, sourceRevision: projected.sourceRevisions[periodKey], rows: projected.rows, core: Payroll,
    closedAt: "2026-10-15T23:59:00-04:00", frozenAt: "2026-10-15T23:59:00-04:00", snapshotId: "018f47a2-13a4-7b2c-8d2a-1afc808d1020" });
}
function jobs() {
  const rows = new Map();
  return { rows,
    async get(key) { return rows.get(key) || null; },
    async insertQueued(value) { if (rows.has(value.idempotency_key)) return false; rows.set(value.idempotency_key, { ...value, state: "queued" }); return true; },
    async transition(key, state, patch = {}) { rows.set(key, { ...rows.get(key), ...patch, state, attempt_count: (rows.get(key)?.attempt_count || 0) + (state === "running" ? 1 : 0) }); },
    async retryKnownNoEffect(key, { requestDigest, startedAt, leaseExpiresAt } = {}) {
      const row = rows.get(key);
      if (!row || row.state !== "failed" || row.job_type !== "calendar_mark" || row.request_digest !== requestDigest ||
          row.result_code !== "failed" || row.result_payload?.failureClass !== "provider_declined_without_effect") return false;
      rows.set(key, { ...row, state: "running", started_at: startedAt, lease_expires_at: leaseExpiresAt,
        result_code: null, result_payload: null, completed_at: null, attempt_count: (row.attempt_count || 0) + 1 });
      return true;
    }
  };
}
function audit() { const rows = new Map(); return { rows, async record(event) { rows.set(event.idempotencyKey, event); } }; }

test("worker runs only on the configured New York 18th after 72 hours and checks source revision first", async () => {
  const closed = await snap();
  const writes = [], audits = audit();
  const worker = createPayrollCalendarPaymentWorker({ enabled: true,
    snapshotStore: { async listClosedSnapshots() { return [closed]; } },
    sourceReader: { async getPeriodRevision({ periodKey }) { assert.equal(periodKey, closed.periodKey); return closed.sourceRevision; } },
    writer: { async preflightClosedSnapshot({ snapshot }) { assert.equal(snapshot.id, closed.id); return { state: "ready" }; },
      async setPaidFlagByStableAssignmentId(input) { writes.push(input); return { updated: true }; } },
    jobs: jobs(), audit: audits });
  const earlyTime = await worker.run(new Date("2026-10-18T23:58:00-04:00"));
  assert.equal(earlyTime.state, "not_due_time");
  const result = await worker.run(new Date("2026-10-18T23:59:00-04:00"));
  assert.equal(result.state, "succeeded");
  assert.equal(result.periods[0].changed, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].origin, "automatic-calendar-policy");
  assert.equal(writes[0].paidFlag, true);
  assert.equal(writes[0].technicianId, "tech-fixture-1");
  assert.equal(writes[0].sheetMetadataId, 321);
  assert.equal(writes[0].sourceFingerprintHash, closed.lines[0].sourceFingerprintHash);
  assert.equal(writes[0].dueDate, "2026-10-18");
  assert.equal([...audits.rows.values()][0].origin, "automatic-calendar-policy");
});

test("worker fails closed on a changed Sheet, late close, unknown paid flag, and missed date", async () => {
  const closed = await snap();
  let writes = 0;
  const setup = (snapshot, revision = snapshot.sourceRevision, preflight = { state: "ready" }) => createPayrollCalendarPaymentWorker({ enabled: true,
    snapshotStore: { async listClosedSnapshots() { return [snapshot]; } },
    sourceReader: { async getPeriodRevision() { return revision; } },
    writer: { async preflightClosedSnapshot() { return preflight; }, async setPaidFlagByStableAssignmentId() { writes++; return { updated: true }; } },
    jobs: jobs(), audit: audit() });
  const when = new Date("2026-10-18T23:59:00-04:00");
  const changed = await setup(closed, "c".repeat(64)).run(when);
  assert.equal(changed.periods[0].reason, "source_changed_since_close");
  const late = await snap({ closedAt: "2026-10-16T01:00:00-04:00", frozenAt: "2026-10-16T01:00:00-04:00" });
  const lateResult = await setup(late).run(when);
  assert.equal(lateResult.periods[0].reason, "finance_review_window_open");
  const unknown = await snap({ source: { paidTP: undefined } });
  const unknownResult = await setup(unknown, unknown.sourceRevision, { state: "needs_review", reason: "payment_flag_or_row_metadata_missing" }).run(when);
  assert.equal(unknownResult.periods[0].state, "needs_review");
  const missed = await setup(closed).run(new Date("2026-10-19T23:59:00-04:00"));
  assert.equal(missed.periods[0].state, "missed_run_review");
  assert.equal(writes, 0);
});

test("worker stays disabled by default and reads no Sheet or writer until configured", async () => {
  let reads = 0;
  const worker = createPayrollCalendarPaymentWorker({ snapshotStore: { async listClosedSnapshots() { reads++; return []; } } });
  assert.deepEqual(await worker.run(new Date("2026-10-18T23:59:00-04:00")), { state: "disabled", periods: [] });
  assert.equal(reads, 0);
});

test("Q2 calendar batch is due on the next month's 3rd in New York, including year rollover", async () => {
  const closed = await snap({ source: { date: "2026-12-22", period: "2DA QUINCENA" },
    closedAt: "2026-12-31T23:59:00-05:00", frozenAt: "2026-12-31T23:59:00-05:00" });
  const writes = [];
  const worker = createPayrollCalendarPaymentWorker({ enabled: true,
    snapshotStore: { async listClosedSnapshots() { return [closed]; } },
    sourceReader: { async getPeriodRevision() { return closed.sourceRevision; } },
    writer: { async preflightClosedSnapshot() { return { state: "ready" }; }, async setPaidFlagByStableAssignmentId(input) { writes.push(input); return { updated: true }; } },
    jobs: jobs(), audit: audit() });
  const result = await worker.run(new Date("2027-01-03T23:59:00-05:00"));
  assert.equal(result.state, "succeeded");
  assert.equal(result.periods[0].dueDate, "2027-01-03");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].periodKey, "2026-12-Q2");
});

test("calendar worker resumes a partial run only for its durably verified assignment and never repeats that Sheet write", async () => {
  const closed = await snapWithTwoAssignments();
  assert.equal(closed.lines.length, 2);
  const jobStore = jobs(), audits = audit(), paid = new Set(), writes = [];
  let failSecondOnce = true;
  const writer = {
    async preflightClosedSnapshot({ snapshot, attributedPaidAssignments = [] }) {
      const attributed = new Set(attributedPaidAssignments.map(item => `${item.assignmentId}:${item.role}`));
      for (const line of snapshot.lines.filter(item => item.amount > 0)) {
        const key = `${line.assignmentId}:${line.role}`;
        if (paid.has(key) && !attributed.has(key)) return { state: "needs_review", reason: "manual_payment_conflict" };
        if (attributed.has(key) && !paid.has(key)) return { state: "needs_review", reason: "automated_payment_flag_missing" };
      }
      return { state: "ready" };
    },
    async setPaidFlagByStableAssignmentId(input) {
      const key = `${input.assignmentId}:${input.role}`;
      writes.push(key);
      if (input.assignmentId === closed.lines[1].assignmentId && failSecondOnce) {
        failSecondOnce = false;
        const error = new Error("synthetic_provider_declined");
        error.noSideEffect = true;
        throw error;
      }
      if (paid.has(key)) return { conflict: true };
      paid.add(key);
      return { updated: true, verified: true, origin: "automatic-calendar-policy" };
    }
  };
  const worker = createPayrollCalendarPaymentWorker({ enabled: true,
    snapshotStore: { async listClosedSnapshots() { return [closed]; } },
    sourceReader: { async getPeriodRevision() { return closed.sourceRevision; } },
    writer, jobs: jobStore, audit: audits });
  const when = new Date("2026-10-18T23:59:00-04:00");
  const first = await worker.run(when);
  assert.equal(first.periods[0].state, "failed");
  assert.equal(first.periods[0].changed, 1);
  assert.equal(paid.size, 1);

  const second = await worker.run(when);
  assert.equal(second.periods[0].state, "succeeded");
  assert.equal(second.periods[0].changed, 1, "only the newly written second assignment counts as changed");
  assert.equal(paid.size, 2);
  assert.equal(writes.length, 3);
  assert.equal(writes.filter(key => key === `${closed.lines[0].assignmentId}:${closed.lines[0].role}`).length, 1,
    "the previously completed assignment must not be rewritten");
  assert.equal(writes.filter(key => key === `${closed.lines[1].assignmentId}:${closed.lines[1].role}`).length, 2,
    "only the known no-effect failure is retried");
  const firstJob = [...jobStore.rows.values()].find(row => row.result_payload?.assignmentId === closed.lines[0].assignmentId);
  assert.equal(firstJob.state, "succeeded");
  assert.equal(firstJob.result_payload.origin, "automatic-calendar-policy");
  assert.equal(audits.rows.size, 3, "the retry is a separate auditable attempt");

  let manualWrites = 0;
  const manualWorker = createPayrollCalendarPaymentWorker({ enabled: true,
    snapshotStore: { async listClosedSnapshots() { return [closed]; } },
    sourceReader: { async getPeriodRevision() { return closed.sourceRevision; } },
    writer: { async preflightClosedSnapshot({ attributedPaidAssignments }) {
      assert.deepEqual(attributedPaidAssignments, []);
      return { state: "needs_review", reason: "manual_payment_conflict" };
    }, async setPaidFlagByStableAssignmentId() { manualWrites++; return { updated: true }; } },
    jobs: jobs(), audit: audit() });
  const manualConflict = await manualWorker.run(when);
  assert.equal(manualConflict.periods[0].reason, "manual_payment_conflict");
  assert.equal(manualWrites, 0);
});
