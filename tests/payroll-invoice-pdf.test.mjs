import test from "node:test";
import assert from "node:assert/strict";
import { generatePayrollInvoicePdf } from "../payroll-invoice-pdf.mjs";

const line = (index, overrides = {}) => ({
  date: "2026-10-15",
  project: `Synthetic project ${index} with a long descriptive name`,
  client: "Synthetic client",
  activity: "MITIGATION",
  caseName: `KITCHEN CASE ${index}`,
  role: index % 2 ? "TP" : "TA1",
  jobStatus: index % 3 ? "COMPLETED" : "REALIZADO",
  paidState: index % 4 ? "unpaid" : "paid",
  amount: 125.5,
  ...overrides
});

const invoice = overrides => ({
  technician: "Técnico de Prueba",
  periodKey: "2026-10-Q1",
  periodLabel: "1.ª quincena de octubre 2026",
  reference: "NOM-202610-Q1-FIXTURE",
  generatedAt: "2026-10-29T12:00:00.000Z",
  lines: [line(1), line(2)],
  total: 251,
  paid: 125.5,
  pending: 125.5,
  balance: 125.5,
  reportPendingCount: 0,
  ...overrides
});

function latin1(bytes) { return new TextDecoder("latin1").decode(bytes); }

test("creates a valid PDF preview with the expected metadata, rows, and admin-state warning", () => {
  const result = generatePayrollInvoicePdf(invoice());
  const pdf = latin1(result.bytes);
  assert.equal(result.state, "preview-only");
  assert.equal(result.fileName, "NOMINA-2026-10-Q1-BORRADOR.pdf");
  assert.match(pdf.slice(0, 8), /^%PDF-1\.4/);
  assert.match(pdf, /\/Type \/Catalog/);
  assert.match(pdf, /\/Count 1/);
  assert.match(pdf, /Técnico de Prueba/);
  assert.match(pdf, /PROYECTO \/ CLIENTE/);
  assert.match(pdf, /transferencias bancarias/);
  assert.match(pdf, /%%EOF/);
});

test("splits long invoices into letter-sized pages and repeats the table header", () => {
  const result = generatePayrollInvoicePdf(invoice({ lines: Array.from({ length: 42 }, (_, i) => line(i + 1)) }));
  const pdf = latin1(result.bytes);
  assert.ok(result.pageCount >= 3);
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, result.pageCount);
  assert.match(pdf, new RegExp(`/Count ${result.pageCount} /Kids \\[`));
  assert.equal((pdf.match(/PROYECTO \/ CLIENTE/g) || []).length, result.pageCount);
});

test("unknown slot amounts stay visibly unresolved in the PDF total", () => {
  const result = generatePayrollInvoicePdf(invoice({
    total: null,
    knownTotal: 0,
    balance: null,
    amountReviewCount: 1,
    lines: [line(1, { amount: null, paidState: "review" })]
  }));
  const pdf = latin1(result.bytes);
  assert.match(pdf, /Revisión requerida/);
  assert.match(pdf, /revisión/);
});

test("rejects malformed or empty invoice data", () => {
  assert.throws(() => generatePayrollInvoicePdf(null), /invoice_data_required/);
  assert.throws(() => generatePayrollInvoicePdf(invoice({ lines: [] })), /invoice_data_required/);
  assert.throws(() => generatePayrollInvoicePdf(invoice({ lines: [line(1, { amount: -1 })] })), /invoice_line_invalid/);
});
