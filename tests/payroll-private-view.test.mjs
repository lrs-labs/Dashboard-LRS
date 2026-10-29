import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core.js";
import { buildPayrollInvoice, filterPayrollLines, getPayrollPeriodOptions } from "../payroll-private-view.mjs";

const row = overrides => ({
  date: "2026-10-07",
  period: "1RA QUINCENA",
  category: "NEW",
  client: "Fixture Client",
  project: "Fixture Project",
  activity: "MITIGATION",
  caseName: "KITCHEN",
  status: "COMPLETED",
  tp: "Tech Fixture A",
  ta1: "Tech Fixture B",
  ta2: "",
  amountTP: 180,
  amountTA1: 130,
  amountTA2: 0,
  paidTP: false,
  paidTA1: true,
  paidTA2: false,
  report: "YES",
  ...overrides
});

const buildLines = rows => Payroll.buildAssignments(rows).lines;

test("period picker keeps current New York quincena as the default even without rows", () => {
  const periods = getPayrollPeriodOptions([], "2026-01-01T02:00:00Z", Payroll);
  assert.deepEqual(periods.map(item => item.key), ["2025-12-Q2"]);
});

test("filters all dimensions and supports all-period view", () => {
  const lines = buildLines([
    row(),
    row({ date: "2026-10-23", period: "2DA QUINCENA", activity: "REMEDIATION", caseName: "BATHROOM", tp: "Tech Fixture A", amountTP: 90 }),
    row({ category: "EXTERNO", tp: "Tech Fixture A", ta1: "", amountTP: 55, amountTA1: 0, paidTP: false })
  ]);
  const result = filterPayrollLines(lines, {
    period: "2026-10-Q1", technician: "Tech Fixture A", role: "TP", activity: "MITIGATION",
    caseName: "KITCHEN", project: "fixture project", paymentStatus: "unpaid"
  }, Payroll);
  assert.equal(result.length, 2);
  assert.equal(filterPayrollLines(lines, { period: "all", technician: "Tech Fixture A" }, Payroll).length, 3);
  assert.equal(filterPayrollLines(lines, { period: "bad" }, Payroll).length, 0);
});

test("invoice uses every technician line in the selected closed-period view, not the table filters", () => {
  const lines = buildLines([
    row(),
    row({ date: "2026-10-12", tp: "Tech Fixture A", ta1: "", amountTP: 40, amountTA1: 0, activity: "REPAIR", paidTP: true }),
    row({ date: "2026-10-23", period: "2DA QUINCENA", tp: "Tech Fixture A", ta1: "", amountTP: 90, amountTA1: 0 })
  ]);
  const invoice = buildPayrollInvoice(lines, "Tech Fixture A", "2026-10-Q1", Payroll);
  assert.equal(invoice.lines.length, 2);
  assert.equal(invoice.total, 220);
  assert.equal(invoice.paid, 40);
  assert.equal(invoice.pending, 180);
  assert.equal(invoice.balance, 180);
  assert.equal(invoice.state, "preview-only");
  assert.equal(invoice.periodLabel, "1.ª quincena de octubre 2026");
  assert.match(invoice.reference, /^NOM-202610-Q1-/);
  assert.equal(buildPayrollInvoice(lines, "Tech Fixture A", "2026-10-Q2", Payroll).lines.length, 1);
  assert.equal(buildPayrollInvoice(lines, "Tech Fixture A", "all", Payroll), null);
});

test("unknown flags block a conclusive invoice balance while retaining known paid and pending amounts", () => {
  const lines = buildLines([row({ paidTP: undefined, amountTP: 180 }), row({ tp: "Tech Fixture A", ta1: "", amountTP: 40, amountTA1: 0, paidTP: true })]);
  const invoice = buildPayrollInvoice(lines, "Tech Fixture A", "2026-10-Q1", Payroll);
  assert.equal(invoice.total, 220);
  assert.equal(invoice.paid, 40);
  assert.equal(invoice.pending, 0);
  assert.equal(invoice.balance, null);
  assert.equal(invoice.review, 180);
  assert.equal(invoice.reviewCount, 1);
});
