import test from "node:test";
import assert from "node:assert/strict";
import Payroll from "../payroll-core-private.js";
import { buildPayrollInvoice, filterPayrollLines, getPayrollPeriodOptions, getPayrollReviewMetrics } from "../payroll-private-view.mjs";

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

test("review metrics separate filtered assignments from source-wide unclassifiable rows", () => {
  const model = Payroll.buildAssignments([
    row({ date: "2026-10-14", period: "1RA QUINCENA", tp: "Tech Fixture A", amountTP: 100, paidTP: false, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-16", period: "2DA QUINCENA", tp: "Tech Fixture A", amountTP: 200, paidTP: undefined, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-20", period: "2DA QUINCENA", tp: "Tech Fixture B", amountTP: "??", paidTP: false, ta1: "", amountTA1: 0 }),
    row({ date: "2026-11-02", period: "1RA QUINCENA", tp: "Tech Fixture A", amountTP: 300, paidTP: true, ta1: "", amountTA1: 0 }),
    row({ date: "", period: "2DA QUINCENA", tp: "Tech Fixture A", amountTP: 500, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-22", period: "", tp: "Tech Fixture A", amountTP: 80, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-25", period: "2DA QUINCENA", tp: "", amountTP: 50, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-25", period: "2DA QUINCENA", category: "NEW", status: "CANCELED", tp: "Tech Fixture A", amountTP: "??", ta1: "", amountTA1: 0 })
  ]);
  const q2 = filterPayrollLines(model.lines, { period: "2026-10-Q2" }, Payroll);
  const q2Metrics = getPayrollReviewMetrics(q2, model);

  assert.equal(model.lines.length, 4, "rows without a date or period and unassigned amounts are not payroll assignments");
  assert.deepEqual({
    paymentFlags: q2Metrics.paymentFlagReviewCount,
    amounts: q2Metrics.amountReviewCount
  }, { paymentFlags: 1, amounts: 1 });
  assert.deepEqual({
    unclassifiedRows: q2Metrics.sourceUnclassifiedRowCount,
    feeReviewRows: q2Metrics.sourceFeeReviewRowCount,
    unassignedSlots: q2Metrics.sourceUnassignedSlotCount
  }, { unclassifiedRows: 2, feeReviewRows: 1, unassignedSlots: 1 });

  const techA = filterPayrollLines(model.lines, { period: "2026-10-Q2", technician: "Tech Fixture A" }, Payroll);
  const techAMetrics = getPayrollReviewMetrics(techA, model);
  assert.equal(techA.length, 1);
  assert.equal(techAMetrics.paymentFlagReviewCount, 1);
  assert.equal(techAMetrics.amountReviewCount, 0);
  assert.equal(techAMetrics.sourceUnclassifiedRowCount, 2, "source-wide notices stay separately labeled and do not enter the filtered count");

  const q1 = filterPayrollLines(model.lines, { period: "2026-10-Q1" }, Payroll);
  const q1Metrics = getPayrollReviewMetrics(q1, model);
  assert.equal(q1.length, 1);
  assert.equal(q1.reduce((sum, line) => sum + line.amount, 0), 100);
  assert.equal(q1Metrics.paymentFlagReviewCount, 0);
  assert.equal(q1Metrics.amountReviewCount, 0);
  assert.equal(Payroll.summarize(q1)[0].pending, 100);

  const november = filterPayrollLines(model.lines, { period: "2026-11-Q1" }, Payroll);
  assert.equal(november.length, 1);
  assert.equal(november.reduce((sum, line) => sum + line.amount, 0), 300);
  assert.equal(getPayrollReviewMetrics(november, model).paymentFlagReviewCount, 0);
});

test("second half of October includes dates 16 through 31 while missing date/period rows remain unclassified", () => {
  const model = Payroll.buildAssignments([
    row({ date: "2026-10-15", period: "1RA QUINCENA", tp: "Tech Fixture A", amountTP: 10, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-16", period: "2DA QUINCENA", tp: "Tech Fixture A", amountTP: 20, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-31", period: "2DA QUINCENA", tp: "Tech Fixture A", amountTP: 30, ta1: "", amountTA1: 0 }),
    row({ date: "", period: "2DA QUINCENA", tp: "Tech Fixture A", amountTP: 40, ta1: "", amountTA1: 0 }),
    row({ date: "2026-10-25", period: "", tp: "Tech Fixture A", amountTP: 50, ta1: "", amountTA1: 0 })
  ]);
  const secondHalf = filterPayrollLines(model.lines, { period: "2026-10-Q2" }, Payroll);
  assert.deepEqual(secondHalf.map(line => line.date).sort(), ["2026-10-16", "2026-10-31"]);
  assert.equal(secondHalf.reduce((sum, line) => sum + line.amount, 0), 50);
  assert.equal(getPayrollReviewMetrics(secondHalf, model).sourceUnclassifiedRowCount, 2);
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

test("an unreadable slot amount blocks the invoice total instead of turning it into zero", () => {
  const lines = buildLines([row({ amountTP: "??", paidTP: false, ta1: "", amountTA1: 0 })]);
  const invoice = buildPayrollInvoice(lines, "Tech Fixture A", "2026-10-Q1", PayrollCore);
  assert.equal(invoice.total, null);
  assert.equal(invoice.knownTotal, 0);
  assert.equal(invoice.amountReviewCount, 1);
  assert.equal(invoice.balance, null);
});
