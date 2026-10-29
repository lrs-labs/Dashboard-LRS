import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { authorizePayrollRead, dateOnly, isAllowedOrigin, mapPayrollRanges } from "../supabase/functions/payroll-api/policy.mjs";
const require = createRequire(import.meta.url);
const PayrollCore = require("../payroll-core.js");

test("no profile, inactive users, and missing capabilities fail closed", () => {
  assert.equal(authorizePayrollRead(null).ok, false);
  assert.equal(authorizePayrollRead({ is_active: false, can_view_payroll: true, scope_mode: "all" }).reason, "not_authorized");
  assert.equal(authorizePayrollRead({ is_active: true, can_view_payroll: false, scope_mode: "all" }).reason, "not_authorized");
});

test("all-scope payroll reader may continue only with an explicit active permission", () => {
  assert.deepEqual(authorizePayrollRead({ is_active: true, can_view_payroll: true, scope_mode: "all" }), { ok: true, scope: "all" });
});

test("selected scope is blocked until stable technician IDs are mapped to source slots", () => {
  assert.equal(authorizePayrollRead({ is_active: true, can_view_payroll: true, scope_mode: "selected", technician_ids: ["tech-1"] }).reason, "stable_technician_mapping_required");
  assert.equal(authorizePayrollRead({ is_active: true, can_view_payroll: true, scope_mode: "selected", technician_ids: [] }).reason, "scope_not_configured");
  assert.equal(authorizePayrollRead({ is_active: true, can_view_payroll: true, scope_mode: "none" }).reason, "scope_not_configured");
});

test("request origin requires an explicit exact HTTPS runtime allowlist", () => {
  assert.equal(isAllowedOrigin("", "https://lrs.kpwr.dev"), false);
  assert.equal(isAllowedOrigin(undefined, "https://lrs.kpwr.dev"), false);
  assert.equal(isAllowedOrigin("http://lrs.kpwr.dev", "http://lrs.kpwr.dev"), false);
  assert.equal(isAllowedOrigin("https://lrs.kpwr.dev", "https://attacker.example"), false);
  assert.equal(isAllowedOrigin("https://lrs.kpwr.dev", "https://lrs.kpwr.dev"), true);
});

test("Sheets serial dates and supported date strings are normalized", () => {
  assert.equal(dateOnly(46302), "2026-10-07");
  assert.equal(dateOnly("2026-10-15T12:30:00Z"), "2026-10-15");
  assert.equal(dateOnly("10/18/2026"), "2026-10-18");
  assert.equal(dateOnly("not a date"), "");
});

test("the API projection reads only payroll fields and keeps AF:AH unknowns distinguishable", () => {
  const data = mapPayrollRanges([
    { range: "REGISTRO_CASOS!B3:B", values: [[46302]] },
    { range: "REGISTRO_CASOS!F3:H", values: [["1RA QUINCENA", "EXTERNO", "Fixture Client"]] },
    { range: "REGISTRO_CASOS!J3:K", values: [["MITIGATION", "KITCHEN"]] },
    { range: "REGISTRO_CASOS!P3:P", values: [["COMPLETED"]] },
    { range: "REGISTRO_CASOS!U3:W", values: [["Fixture Tech A", "Fixture Tech B", ""]] },
    { range: "REGISTRO_CASOS!X3:Z", values: [[180, 130, 0]] },
    { range: "REGISTRO_CASOS!AF3:AH", values: [[false, true]] },
    { range: "REGISTRO_CASOS!AI3:AI", values: [["YES"]] },
    { range: "REGISTRO_CASOS!AO3:AO", values: [["Fixture Project"]] }
  ]);
  assert.equal(data.length, 1);
  assert.deepEqual(data[0], {
      date: "2026-10-07", period: "1RA QUINCENA", category: "EXTERNO", client: "Fixture Client",
    activity: "MITIGATION", caseName: "KITCHEN", status: "COMPLETED", tp: "Fixture Tech A", ta1: "Fixture Tech B", ta2: "",
    amountTP: 180, amountTA1: 130, amountTA2: 0, paidTP: false, paidTA1: true, paidTA2: "", report: "YES", project: "Fixture Project"
  });
  assert.equal("sourceRowNumber" in data[0], false);
  assert.equal("address" in data[0], false);
  assert.equal("email" in data[0], false);
});

test("unassigned blank rows are omitted without shifting a later row", () => {
  const data = mapPayrollRanges([
    { range: "REGISTRO_CASOS!B3:B", values: [[""], [46302]] },
    { range: "REGISTRO_CASOS!F3:H", values: [["", "", ""], ["1RA QUINCENA", "NEW", "Fixture"]] },
    { range: "REGISTRO_CASOS!U3:W", values: [[], ["Fixture Tech"]] },
    { range: "REGISTRO_CASOS!X3:Z", values: [[], [100]] }
  ]);
  assert.equal(data.length, 1);
  assert.equal(data[0].tp, "Fixture Tech");
  assert.equal(data[0].amountTP, 100);
});

test("private API projection preserves EXTERNO payroll and marks missing payment flags for review", () => {
  const rows = mapPayrollRanges([
    { range: "REGISTRO_CASOS!B3:B", values: [[46302]] },
    { range: "REGISTRO_CASOS!F3:H", values: [["1RA QUINCENA", "EXTERNO", "Fixture Client"]] },
    { range: "REGISTRO_CASOS!J3:K", values: [["MITIGATION", "KITCHEN"]] },
    { range: "REGISTRO_CASOS!P3:P", values: [["REALIZADO"]] },
    { range: "REGISTRO_CASOS!U3:W", values: [["Fixture Tech", "", ""]] },
    { range: "REGISTRO_CASOS!X3:Z", values: [[225, 0, 0]] },
    { range: "REGISTRO_CASOS!AF3:AH", values: [[null]] },
    { range: "REGISTRO_CASOS!AI3:AI", values: [["NO"]] },
    { range: "REGISTRO_CASOS!AO3:AO", values: [["Fixture Project"]] }
  ]);
  const model = PayrollCore.buildAssignments(rows);
  assert.equal(model.lines.length, 1);
  assert.equal(model.lines[0].category, "EXTERNO");
  assert.equal(model.lines[0].project, "Fixture Project");
  assert.equal(model.lines[0].paidState, "review");
  assert.equal(model.lines[0].jobStatus, "REALIZADO");
  assert.equal(model.lines[0].reportPending, true);
});
