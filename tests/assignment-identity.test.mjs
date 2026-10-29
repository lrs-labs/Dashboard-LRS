import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssignmentIdentities } from "../supabase/functions/payroll-api/assignment-identity.mjs";

const line = overrides => ({
  eventRef: "email-event-fixture-47",
  periodKey: "2026-10-Q1",
  date: "2026-10-08",
  project: "Fixture Project",
  client: "Fixture Client",
  caseName: "CASE-47",
  activity: "MITIGATION",
  jobStatus: "COMPLETED",
  technicianId: "tech-fixture-1",
  role: "TP",
  amount: 180,
  paidFlag: false,
  ...overrides
});

function memoryIdentityStore(seed = []) {
  const records = new Map(seed.map(record => [record.identityKeyHash, record]));
  const inserts = [];
  return {
    records,
    inserts,
    async findByIdentityHash(hash) { return records.get(hash) || null; },
    async createPending(record) {
      inserts.push(record);
      if (records.has(record.identityKeyHash)) return { conflict: true };
      const row = { ...record, state: "pending_review" };
      records.set(record.identityKeyHash, row);
      return row;
    }
  };
}

test("first-seen assignments receive only a pending opaque sidecar mapping", async () => {
  const store = memoryIdentityStore();
  const [result] = await resolveAssignmentIdentities([line()], { store, createId: () => "018f47a2-13a4-7b2c-8d2a-1afc808d1001" });
  assert.equal(result.state, "pending_review");
  assert.equal(result.assignmentId, null);
  assert.equal(store.inserts.length, 1);
  assert.deepEqual(Object.keys(store.inserts[0]).sort(), ["assignmentId", "identityKeyHash", "sourceFingerprintHash"].sort());
  assert.match(store.inserts[0].identityKeyHash, /^[a-f0-9]{64}$/);
  assert.match(store.inserts[0].sourceFingerprintHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(store.inserts[0]), /email-event-fixture-47|Fixture Project|CASE-47/);
});

test("verified assignment IDs are invariant to source row order and paid-flag changes", async () => {
  const originalA = line({ eventRef: "mail-a", caseName: "CASE-A" });
  const originalB = line({ eventRef: "mail-b", caseName: "CASE-B", role: "TA1", technicianId: "tech-fixture-2" });
  const pendingStore = memoryIdentityStore();
  await resolveAssignmentIdentities([originalA, originalB], { store: pendingStore, createId: (() => { let i = 1; return () => `018f47a2-13a4-7b2c-8d2a-${String(i++).padStart(12, "0")}`; })() });
  for (const record of pendingStore.records.values()) record.state = "verified";
  const verified = memoryIdentityStore([...pendingStore.records.values()]);
  const forward = await resolveAssignmentIdentities([originalA, originalB], { store: verified });
  const reversed = await resolveAssignmentIdentities([
    { ...originalB, paidFlag: true }, { ...originalA, paidFlag: true }
  ], { store: verified });
  assert.equal(forward[0].assignmentId, reversed[1].assignmentId);
  assert.equal(forward[1].assignmentId, reversed[0].assignmentId);
  assert.equal(forward.every(result => result.state === "verified"), true);
});

test("changed assignment facts and unverified mappings require review", async () => {
  const pendingStore = memoryIdentityStore();
  await resolveAssignmentIdentities([line()], { store: pendingStore, createId: () => "018f47a2-13a4-7b2c-8d2a-1afc808d1002" });
  const [changed] = await resolveAssignmentIdentities([line({ amount: 181 })], { store: pendingStore });
  assert.equal(changed.state, "needs_review");
  assert.equal(changed.assignmentId, null);
  const [stillPending] = await resolveAssignmentIdentities([line()], { store: pendingStore });
  assert.equal(stillPending.state, "pending_review");
  assert.equal(stillPending.assignmentId, null);
});

test("missing event identity and duplicate source facts are blocked without guessing by row position", async () => {
  const store = memoryIdentityStore();
  const [missing] = await resolveAssignmentIdentities([line({ eventRef: "" })], { store });
  assert.equal(missing.state, "unresolved");
  assert.equal(missing.reason, "stable_event_reference_required");
  const duplicates = await resolveAssignmentIdentities([line(), line()], { store });
  assert.equal(duplicates.every(result => result.state === "ambiguous"), true);
  assert.equal(store.inserts.length, 0);
});

