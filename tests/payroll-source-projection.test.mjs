import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { createPayrollReadProjection, filterPayrollRowsByTechnicianScope, projectPayrollRowsWithAssignmentIds } from "../supabase/functions/payroll-api/payroll-source-projection.mjs";

const source = overrides => ({
  date: "2026-10-08", period: "1RA QUINCENA", category: "NEW", client: "Fixture Client",
  project: "Fixture Project", activity: "MITIGATION", caseName: "CASE-7", status: "COMPLETED",
  tp: "Fixture Tech", ta1: "", ta2: "", amountTP: 180, amountTA1: 0, amountTA2: 0,
  paidTP: false, paidTA1: false, paidTA2: false, report: "YES", ...overrides
});
const roster = [{ technicianId: "tech-fixture-1", displayName: "Fixture Tech", active: true }];
function memoryStore() {
  const records = new Map();
  return {
    records,
    async findByIdentityHash(key) { return records.get(key) || null; },
    async createPending(record) {
      if (records.has(record.identityKeyHash)) return { conflict: true };
      records.set(record.identityKeyHash, { ...record, state: "pending_review" });
      return { inserted: true };
    }
  };
}

test("projection adds no row index identity and only exposes verified sidecar IDs", async () => {
  const store = memoryStore();
  const first = await projectPayrollRowsWithAssignmentIds([source()], { core: Payroll, roster, identityStore: store,
    createId: () => "018f47a2-13a4-7b2c-8d2a-1afc808d1001" });
  assert.equal(first.rows[0].assignmentIdentityStates.TP, "pending_review");
  assert.equal(first.rows[0].assignmentIds.TP, undefined);
  const [identity] = [...store.records.values()];
  identity.state = "verified";
  const second = await projectPayrollRowsWithAssignmentIds([source()], { core: Payroll, roster, identityStore: store });
  const line = Payroll.buildAssignments(second.rows).lines[0];
  assert.equal(line.assignmentId, "018f47a2-13a4-7b2c-8d2a-1afc808d1001");
  assert.equal(line.identityState, "verified");
  assert.equal("rowIndex" in line, false);
});

test("content-addressed sidecar identity survives reorder, while duplicate source facts are ambiguous", async () => {
  const a = source();
  const b = source({ caseName: "CASE-8", client: "Other Fixture Client" });
  const store = memoryStore();
  await projectPayrollRowsWithAssignmentIds([a, b], { core: Payroll, roster, identityStore: store,
    createId: (() => { let n = 1; return () => `018f47a2-13a4-7b2c-8d2a-${String(n++).padStart(12, "0")}`; })() });
  for (const record of store.records.values()) record.state = "verified";
  const forward = await projectPayrollRowsWithAssignmentIds([a, b], { core: Payroll, roster, identityStore: store });
  const reverse = await projectPayrollRowsWithAssignmentIds([b, a], { core: Payroll, roster, identityStore: store });
  assert.deepEqual(forward.rows.map(row => row.assignmentIds.TP), reverse.rows.slice().reverse().map(row => row.assignmentIds.TP));
  const duplicate = await projectPayrollRowsWithAssignmentIds([a, a], { core: Payroll, roster, identityStore: store });
  assert.deepEqual(duplicate.rows.map(row => row.assignmentIdentityStates.TP), ["ambiguous", "ambiguous"]);
  assert.equal(duplicate.rows.every(row => !row.assignmentIds.TP), true);
});

test("missing or duplicate technician directory names fail closed and sheet payment flags do not alter source revision", async () => {
  const row = source();
  const emptyRoster = await projectPayrollRowsWithAssignmentIds([row], { core: Payroll, roster: [], identityStore: memoryStore() });
  assert.equal(emptyRoster.rows[0].assignmentIdentityStates.TP, "unresolved");
  const duplicateRoster = await projectPayrollRowsWithAssignmentIds([row], { core: Payroll,
    roster: [...roster, { technicianId: "other-tech", displayName: "Fixture Tech", active: true }], identityStore: memoryStore() });
  assert.equal(duplicateRoster.rows[0].assignmentIdentityStates.TP, "unresolved");

  const store = memoryStore();
  const before = await projectPayrollRowsWithAssignmentIds([row], { core: Payroll, roster, identityStore: store });
  const after = await projectPayrollRowsWithAssignmentIds([{ ...row, paidTP: true }], { core: Payroll, roster, identityStore: store });
  assert.equal(before.sourceRevisions["2026-10-Q1"], after.sourceRevisions["2026-10-Q1"]);
  const changedAmount = await projectPayrollRowsWithAssignmentIds([{ ...row, amountTP: 181 }], { core: Payroll, roster, identityStore: store });
  assert.notEqual(before.sourceRevisions["2026-10-Q1"], changedAmount.sourceRevisions["2026-10-Q1"]);
  assert.equal(changedAmount.rows[0].assignmentIdentityStates.TP, "needs_review");
});

test("selected scope removes sibling technician names, amounts, payment flags, and identities", async () => {
  const mixed = source({ ta1: "Fixture Tech B", amountTA1: 95, paidTA1: true });
  const store = memoryStore();
  const bothTechs = [...roster, { technicianId: "tech-fixture-2", displayName: "Fixture Tech B", active: true }];
  let next = 1;
  const options = { core: Payroll, roster: bothTechs, identityStore: store,
    createId: () => `018f47a2-13a4-7b2c-8d2a-${String(next++).padStart(12, "0")}` };
  await projectPayrollRowsWithAssignmentIds([mixed], options);
  for (const record of store.records.values()) record.state = "verified";
  const projected = await projectPayrollRowsWithAssignmentIds([mixed], options);

  const selectedA = filterPayrollRowsByTechnicianScope(projected.rows, ["tech-fixture-1"]);
  assert.equal(selectedA.length, 1);
  assert.equal(selectedA[0].tp, "Fixture Tech");
  assert.equal(selectedA[0].ta1, "");
  assert.equal(selectedA[0].amountTA1, "");
  assert.equal(selectedA[0].paidTA1, undefined);
  assert.equal(selectedA[0].assignmentIds.TA1, undefined);

  const selectedB = filterPayrollRowsByTechnicianScope(projected.rows, ["tech-fixture-2"]);
  assert.equal(selectedB.length, 1);
  assert.equal(selectedB[0].tp, "");
  assert.equal(selectedB[0].amountTP, "");
  assert.equal(selectedB[0].ta1, "Fixture Tech B");
  assert.equal(filterPayrollRowsByTechnicianScope(projected.rows, ["unknown-tech"]).length, 0);
});

test("server read projection rejects missing scope and filters selected users only after verified sidecar mapping", async () => {
  const store = memoryStore();
  const read = createPayrollReadProjection({ core: Payroll, identityStore: store, readRoster: async () => roster });
  const first = await read({ rows: [source()], scopeMode: "all" });
  assert.equal(first.rows[0].assignmentIdentityStates.TP, "pending_review");
  for (const record of store.records.values()) record.state = "verified";
  const selected = await read({ rows: [source()], scopeMode: "selected", technicianIds: ["tech-fixture-1"] });
  assert.equal(selected.rows.length, 1);
  assert.equal(selected.rows[0].assignmentTechnicianIds.TP, "tech-fixture-1");
  await assert.rejects(read({ rows: [source()], scopeMode: "selected", technicianIds: [] }), /selected_payroll_scope_required/);
  await assert.rejects(read({ rows: [source()], scopeMode: "none", technicianIds: [] }), /payroll_scope_invalid/);
});
