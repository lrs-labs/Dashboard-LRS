import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { buildClosedPayrollSnapshot, createImmutablePayrollSnapshotStore, verifyClosedPayrollSnapshot } from "../supabase/functions/payroll-api/payroll-snapshot-store.mjs";
import { createSupabasePayrollSnapshotStorage } from "../supabase/functions/payroll-api/supabase-snapshot-recipient-store.mjs";
import { projectPayrollRowsWithAssignmentIds } from "../supabase/functions/payroll-api/payroll-source-projection.mjs";

const source = { date: "2026-10-08", period: "1RA QUINCENA", category: "EXTERNO", client: "Fixture Client", project: "Fixture Project",
  activity: "MITIGATION", caseName: "CASE-7", status: "REALIZADO", tp: "Fixture Tech", ta1: "", ta2: "",
  amountTP: 180, amountTA1: 0, amountTA2: 0, paidTP: false, paidTA1: false, paidTA2: false, report: "NO" };
const roster = [{ technicianId: "tech-fixture-1", displayName: "Fixture Tech", active: true }];
async function projectedRows(input = source) {
  const records = new Map();
  const store = { async findByIdentityHash(key) { return records.get(key) || null; }, async createPending(record) {
    records.set(record.identityKeyHash, { ...record, state: "pending_review" }); return { inserted: true };
  } };
  const createId = () => "018f47a2-13a4-7b2c-8d2a-1afc808d1001";
  await projectPayrollRowsWithAssignmentIds([input], { core: Payroll, roster, identityStore: store, createId });
  for (const record of records.values()) record.state = "verified";
  return projectPayrollRowsWithAssignmentIds([input], { core: Payroll, roster, identityStore: store, createId });
}
async function metadata(overrides = {}) {
  const projected = await projectedRows(overrides.source || source);
  return { periodKey: "2026-10-Q1", sourceRevision: projected.sourceRevisions["2026-10-Q1"], closedAt: "2026-10-16T14:00:00Z", frozenAt: "2026-10-16T14:00:00Z",
    snapshotId: "018f47a2-13a4-7b2c-8d2a-1afc808d1002", rows: projected.rows, ...overrides };
}

function memoryStorage() {
  let snapshot = null;
  return {
    async insertClosedIfAbsent(input) {
      if (!snapshot) { snapshot = input.payload; return { state: "inserted", snapshotId: snapshot.id }; }
      if (snapshot.digest === input.digest && snapshot.sourceRevision === input.sourceRevision) return { state: "same", snapshotId: snapshot.id };
      return { state: "conflict", snapshotId: snapshot.id };
    },
    async getClosed({ periodKey, snapshotId }) { return snapshot?.periodKey === periodKey && snapshot?.id === snapshotId ? structuredClone(snapshot) : null; },
    replaceForTest(value) { snapshot = value; }
  };
}

test("closed snapshot freezes eligible assignments, source digest, per-role paid state, and REALIZADO warning", async () => {
  const params = await metadata();
  const snapshot = await buildClosedPayrollSnapshot({ ...params, core: Payroll });
  assert.equal(snapshot.state, "closed");
  assert.equal(snapshot.frozen, true);
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0].assignmentId, params.rows[0].assignmentIds.TP);
  assert.equal(snapshot.lines[0].paymentState, "unpaid");
  assert.equal(snapshot.lines[0].reportPending, true);
  assert.equal(snapshot.digest.length, 64);
  await verifyClosedPayrollSnapshot(snapshot);
});

test("snapshot close is atomic create-only, idempotent for the same digest, and rejects another revision", async () => {
  const storage = memoryStorage();
  const store = createImmutablePayrollSnapshotStore(storage);
  const params = await metadata();
  const first = await buildClosedPayrollSnapshot({ ...params, core: Payroll });
  assert.equal((await store.close(first)).id, first.id);
  const retry = await buildClosedPayrollSnapshot({ ...params, core: Payroll });
  assert.equal((await store.close(retry)).id, first.id);
  const changed = await buildClosedPayrollSnapshot({ ...params, snapshotId: "018f47a2-13a4-7b2c-8d2a-1afc808d1004", core: Payroll });
  await assert.rejects(store.close(changed), /period_already_closed_review_required/);
});

test("snapshot read detects payload tampering and rejects unknown IDs", async () => {
  const storage = memoryStorage();
  const store = createImmutablePayrollSnapshotStore(storage);
  const params = await metadata();
  const snapshot = await buildClosedPayrollSnapshot({ ...params, core: Payroll });
  await store.close(snapshot);
  await assert.rejects(store.getClosedSnapshot({ periodKey: snapshot.periodKey, snapshotId: "018f47a2-13a4-7b2c-8d2a-1afc808d1009" }), /closed_snapshot_not_found/);
  storage.replaceForTest({ ...snapshot, lines: [{ ...snapshot.lines[0], amount: 181 }] });
  await assert.rejects(store.getClosedSnapshot({ periodKey: snapshot.periodKey, snapshotId: snapshot.id }), /closed_snapshot_digest_mismatch/);
});

test("snapshot builder refuses unknown amounts or unverified assignment IDs", async () => {
  const invalid = { ...source, amountTP: "bad" };
  const invalidProjection = await projectedRows(invalid);
  await assert.rejects(buildClosedPayrollSnapshot({ periodKey: "2026-10-Q1", sourceRevision: invalidProjection.sourceRevisions["2026-10-Q1"], rows: invalidProjection.rows,
    closedAt: "2026-10-16T14:00:00Z", frozenAt: "2026-10-16T14:00:00Z", snapshotId: "018f47a2-13a4-7b2c-8d2a-1afc808d1004", core: Payroll }), /closed_snapshot_assignment_review_required/);
  const unverifiedStore = { records: new Map(), async findByIdentityHash(key) { return this.records.get(key) || null; }, async createPending(record) {
    this.records.set(record.identityKeyHash, { ...record, state: "pending_review" }); return { inserted: true };
  } };
  const pending = await projectPayrollRowsWithAssignmentIds([source], { core: Payroll, roster, identityStore: unverifiedStore,
    createId: () => "018f47a2-13a4-7b2c-8d2a-1afc808d1001" });
  await assert.rejects(buildClosedPayrollSnapshot({ periodKey: "2026-10-Q1", sourceRevision: pending.sourceRevisions["2026-10-Q1"], rows: pending.rows,
    closedAt: "2026-10-16T14:00:00Z", frozenAt: "2026-10-16T14:00:00Z", snapshotId: "018f47a2-13a4-7b2c-8d2a-1afc808d1004", core: Payroll }), /closed_snapshot_assignment_review_required/);
});

test("Supabase snapshot storage uses fixed private RPCs and verifies envelope identity", async () => {
  const calls = [];
  const params = await metadata();
  const snapshot = await buildClosedPayrollSnapshot({ ...params, core: Payroll });
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === "lrs_payroll_snapshot_close") return { data: { state: "inserted", snapshot_id: snapshot.id }, error: null };
    if (name === "lrs_payroll_snapshot_get") return { data: { period_key: snapshot.periodKey, snapshot_id: snapshot.id,
      source_revision: snapshot.sourceRevision, digest: snapshot.digest, payload: snapshot }, error: null };
    throw new Error("unexpected_rpc");
  } };
  const storage = createSupabasePayrollSnapshotStorage(client);
  assert.deepEqual(await storage.insertClosedIfAbsent({ periodKey: snapshot.periodKey, snapshotId: snapshot.id,
    sourceRevision: snapshot.sourceRevision, digest: snapshot.digest, payload: snapshot }), { state: "inserted", snapshotId: snapshot.id });
  assert.deepEqual(await storage.getClosed({ periodKey: snapshot.periodKey, snapshotId: snapshot.id }), snapshot);
  assert.deepEqual(calls.map(item => item.name), ["lrs_payroll_snapshot_close", "lrs_payroll_snapshot_get"]);
  assert.equal(JSON.stringify(calls).includes("example.invalid"), false);
});
