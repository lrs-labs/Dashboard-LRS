const test = require("node:test");
const assert = require("node:assert/strict");
const Payroll = require("../payroll-core.js");

const row = overrides => ({
  date: "2026-10-07",
  period: "1RA QUINCENA",
  category: "NEW",
  client: "Fixture Client A",
  activity: "MITIGATION",
  caseName: "KITCHEN",
  status: "COMPLETED",
  tp: "Technician A",
  ta1: "Technician B",
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

const closedSnapshot = overrides => ({
  snapshotId: "fixture-snapshot-1",
  periodKey: "2026-10-Q1",
  closedAt: "2026-10-15T17:00:00-04:00",
  frozenAt: "2026-10-17T10:00:00-04:00",
  frozen: true,
  assignments: [
    { assignmentId: "fixture-assignment-1", periodKey: "2026-10-Q1", role: "TP", amount: 180, eligible: true, paymentState: "unpaid" },
    { assignmentId: "fixture-assignment-2", periodKey: "2026-10-Q1", role: "TA1", amount: 130, eligible: true, paymentState: "unpaid" },
    { assignmentId: "fixture-manual-paid", periodKey: "2026-10-Q1", role: "TA2", amount: 60, eligible: true, paymentState: "paid" },
    { assignmentId: "fixture-assignment-zero", periodKey: "2026-10-Q1", role: "TA2", amount: 0, eligible: true, paymentState: "zero" }
  ],
  ...overrides
});

const invoiceFixtureLine = overrides => ({
  assignmentId: "fixture-invoice-assignment-1",
  technicianId: "fixture-technician-id",
  periodKey: "2026-10-Q1",
  date: "2026-10-07",
  project: "Fixture Project",
  client: "Fixture Client",
  activity: "MITIGATION",
  caseName: "KITCHEN",
  jobStatus: "COMPLETED",
  role: "TP",
  amount: 180,
  paidState: "unpaid",
  ...overrides
});

const archiveFixture = overrides => {
  const baseline = [invoiceFixtureLine()];
  return {
    period: { year: 2026, month: 10, half: 1 },
    periodClosed: true,
    closedPeriodKey: "2026-10-Q1",
    closedSnapshotId: "fixture-closed-snapshot",
    freshSnapshotId: "fixture-fresh-read",
    technicianId: "fixture-technician-id",
    technicianName: "Technician A",
    sourceReadAt: "2026-10-18T23:49:00-04:00",
    now: "2026-10-18T23:50:00-04:00",
    maxSourceAgeSeconds: 300,
    currentLines: baseline,
    closedSnapshotLines: baseline,
    deliveryMode: "drive-only",
    ...overrides
  };
};

test("solo COMPLETED, REALIZADO y cancelación NEW con fee explícito generan líneas", () => {
  const result = Payroll.buildAssignments([
    row(),
    row({ status: "REALIZADO", period: "2DA QUINCENA", report: "NO" }),
    row({ status: "CANCELED", category: "NEW", amountTP: 45, amountTA1: 0 }),
    row({ status: "CANCELED", category: "NEW", amountTP: 0, amountTA1: 0 }),
    row({ status: "PENDING" }),
    row({ status: "IN PROGRESS" })
  ]);
  assert.equal(result.lines.length, 5);
  assert.equal(result.lines.filter(line => line.cancellationFee).length, 1);
  assert.equal(result.lines.filter(line => line.jobStatus === "REALIZADO" && line.reportPending).length, 2);
  assert.equal(result.excludedStatus, 3);
});

test("preserva roles duplicados legítimos y cada monto registrado en su slot", () => {
  const result = Payroll.buildAssignments([row({
    tp: "Technician A",
    ta1: "Technician A",
    ta2: "Technician A",
    amountTP: 210,
    amountTA1: 210,
    amountTA2: 35
  })]);
  assert.deepEqual(result.lines.map(line => [line.technician, line.role, line.amount]), [
    ["Technician A", "TP", 210], ["Technician A", "TA1", 210], ["Technician A", "TA2", 35]
  ]);
  assert.equal(Payroll.summarize(result.lines)[0].total, 455);
});

test("a source row position is never exposed as a stable assignment ID", () => {
  const alone = Payroll.buildAssignments([row()]).lines[0];
  const afterInsertedRow = Payroll.buildAssignments([row({ client: "Other Fixture Client" }), row()]).lines
    .find(line => line.client === "Fixture Client A");
  assert.equal(alone.id, undefined);
  assert.equal(afterInsertedRow.id, undefined);
  assert.equal(alone.assignmentId, undefined);
  assert.equal(afterInsertedRow.assignmentId, undefined);
});

test("lee pagos por slot, mantiene ceros en cero y no inventa importes para slots vacíos", () => {
  const result = Payroll.buildAssignments([
    row({ amountTP: 0, paidTP: true, amountTA1: 120, paidTA1: true }),
    row({ category: "EXTERNO", tp: "Technician A", ta1: "", ta2: "", amountTP: 999, amountTA1: 0, amountTA2: 0, paidTP: false }),
    row({ category: "EXTERNO", tp: "", ta1: "", ta2: "", amountTP: 0, amountTA1: 0, amountTA2: 0 })
  ]);
  assert.equal(result.lines.length, 3);
  assert.equal(result.lines.find(line => line.role === "TP").paidState, "zero");
  assert.equal(result.lines.find(line => line.role === "TA1").paidState, "paid");
  assert.equal(result.lines.filter(line => line.category === "EXTERNO").length, 1);
  assert.equal(result.unassigned.length, 0);
  assert.equal(Payroll.summarize(result.lines).find(summary => summary.technician === "Technician A").total, 999);
  assert.equal(Payroll.summarize(result.lines).find(summary => summary.technician === "Technician B").total, 120);
});

test("invalid amount stays unknown, blocks conclusive totals, and zero remains a valid zero", () => {
  assert.equal(Payroll.parseAmount(0), 0);
  assert.equal(Payroll.parseAmount("$0.00"), 0);
  assert.equal(Payroll.parseAmount("$1,234.50"), 1234.5);
  assert.equal(Payroll.parseAmount("($ 1,234.50)"), -1234.5);
  for (const invalid of ["not a price", "100oops", "12.50USD", "1,2,3", "1,23", "1 2", "1.2.3", "Infinity", Number.NaN, Number.POSITIVE_INFINITY, ""]) {
    assert.equal(Payroll.parseAmount(invalid), null, `invalid amount ${String(invalid)} must remain unknown`);
  }
  const model = Payroll.buildAssignments([
    row({ amountTP: "—", amountTA1: 0, ta1: "Technician B" }),
    row({ amountTP: 0, tp: "Technician C", amountTA1: 0 })
  ]);
  const unknown = model.lines.find(line => line.technician === "Technician A");
  assert.equal(unknown.amount, null);
  assert.equal(unknown.amountInvalid, true);
  assert.equal(unknown.paidState, "review");
  assert.equal(model.lines.find(line => line.technician === "Technician C").paidState, "zero");
  const summary = Payroll.summarize([unknown])[0];
  assert.equal(summary.total, null);
  assert.equal(summary.knownTotal, 0);
  assert.equal(summary.amountReview, 1);
  assert.equal(summary.balance, null);
});

test("a canceled NEW fee with an unknown amount is routed to review, not silently excluded", () => {
  const model = Payroll.buildAssignments([row({ status: "CANCELED", category: "NEW", amountTP: "?", amountTA1: 0 })]);
  assert.equal(model.lines.length, 0);
  assert.equal(model.reviewRows[0].reason, "invalid-cancellation-fee-amount");
  assert.equal(model.excludedStatus, 0);
});

test("mantiene saldo sin asignar fuera de técnicos e identifica pagos por revisar", () => {
  const result = Payroll.buildAssignments([row({
    tp: "SIN ASIGNAR",
    amountTP: 80,
    ta1: "Technician B",
    amountTA1: 40,
    paidTA1: "valor desconocido"
  })]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.unassigned.length, 1);
  assert.equal(result.unassigned[0].amount, 80);
  assert.equal(result.lines[0].paidState, "review");
  assert.equal(Payroll.summarize(result.lines)[0].review, 40);
});

test("flags de pago ausentes o inválidos se revisan y bloquean el saldo concluyente", () => {
  const lines = Payroll.buildAssignments([
    row({ paidTP: undefined }),
    row({ paidTP: null }),
    row({ paidTP: "" }),
    row({ paidTP: 2 }),
    row({ paidTP: false }),
    row({ paidTP: 0 }),
    row({ paidTP: 1 })
  ]).lines.filter(line => line.role === "TP");
  assert.deepEqual(lines.map(line => line.paidState), ["review", "review", "review", "review", "unpaid", "unpaid", "paid"]);
  const summary = Payroll.summarize(lines)[0];
  assert.equal(summary.review, 720);
  assert.equal(summary.balance, null);
});

test("la lectura del flag GViz conserva la diferencia entre dato ausente y false explícito", () => {
  assert.equal(Payroll.readPaidCell({ c: [] }, 13), undefined);
  assert.equal(Payroll.readPaidCell({ c: [{ v: false }] }, 0), false);
  assert.equal(Payroll.readPaidCell({ c: [{ v: null }] }, 0), null);
  assert.equal(Payroll.readPaidCell({ c: [{ f: "" }] }, 0), "");
});

test("usa el día B para año y mes y el valor F para la quincena de liquidación", () => {
  const result = Payroll.buildAssignments([row({ date: "2026-10-28", period: "1RA QUINCENA" })]);
  assert.equal(result.lines[0].periodKey, "2026-10-Q1");
  assert.equal(result.lines[0].date, "2026-10-28");
  assert.equal(Payroll.buildAssignments([row({ period: "" })]).reviewRows[0].reason, "missing-period");
});

test("filtra por periodo, fechas, técnico, rol, actividad, CASE, proyecto y estado de pago", () => {
  const lines = Payroll.buildAssignments([
    row(),
    row({ date: "2026-10-19", period: "2DA QUINCENA", activity: "REMEDIATION", caseName: "BATHROOM", client: "Fixture Client B" })
  ]).lines;
  const result = Payroll.filterAssignments(lines, {
    year: 2026, month: 10, half: 1, from: "2026-10-01", to: "2026-10-15",
    technician: "Technician A", role: "TP", activity: "MITIGATION", caseName: "KITCHEN",
    project: "fixture client", paymentStatus: "unpaid"
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].technician, "Technician A");
  assert.deepEqual(Payroll.filterAssignments(lines, { from: "2026-10-20", to: "2026-10-01" }), []);
});

test("el periodo predeterminado sigue America/New_York, incluido el cambio de fecha", () => {
  assert.deepEqual(Payroll.currentNYPeriod(new Date("2026-10-01T02:00:00Z")), { year: 2026, month: 9, half: 2 });
  assert.deepEqual(Payroll.currentNYPeriod(new Date("2026-10-15T16:00:00Z")), { year: 2026, month: 10, half: 1 });
  assert.deepEqual(Payroll.currentNYPeriod(new Date("2026-10-16T04:00:00Z")), { year: 2026, month: 10, half: 2 });
});

test("la ventana financiera requiere un cierre explícito y nunca marca pagos", () => {
  const unclosed = Payroll.resolvePeriodReviewWindow(null, "2026-10-19T12:00:00Z", 3);
  assert.equal(unclosed.state, "awaiting-close-record");
  assert.equal(unclosed.periodVisible, true);
  assert.equal(unclosed.autoMarkPaid, false);
  assert.equal(Payroll.resolvePeriodReviewWindow("2026-10-15", "2026-10-19T12:00:00Z", 3).state, "invalid-close-record");
  assert.equal(Payroll.resolvePeriodReviewWindow("2026-10-15T17:00:00-04:00", "2026-10-16T12:00:00Z", null).state, "configuration-required");

  const pendingLine = Payroll.buildAssignments([row({ paidTP: false })]).lines[0];
  const atDeadline = Payroll.resolvePeriodReviewWindow("2026-10-15T17:00:00-04:00", "2026-10-18T21:00:00Z", 3);
  const afterWindow = Payroll.resolvePeriodReviewWindow("2026-10-15T17:00:00-04:00", "2026-10-18T21:00:01Z", 3);
  assert.equal(atDeadline.state, "finance-review");
  assert.equal(afterWindow.state, "confirmation-required");
  assert.equal(afterWindow.reviewUntil, "2026-10-18T21:00:00.000Z");
  assert.equal(afterWindow.periodVisible, true);
  assert.equal(afterWindow.autoMarkPaid, false);
  assert.equal(pendingLine.paidState, "unpaid");
});

test("el cierre explícito abre una ventana configurable de tres días", () => {
  const closedAt = "2026-10-15T17:00:00-04:00";
  assert.equal(Payroll.resolvePeriodReviewWindow(closedAt, "2026-10-15T20:59:59Z", 3).state, "scheduled");
  const atClose = Payroll.resolvePeriodReviewWindow(closedAt, "2026-10-15T21:00:00Z", 3);
  const beforeDeadline = Payroll.resolvePeriodReviewWindow(closedAt, "2026-10-18T20:59:59Z", 3);
  assert.equal(atClose.state, "finance-review");
  assert.equal(atClose.financeReviewWindowOpen, true);
  assert.equal(beforeDeadline.financeReviewWindowOpen, true);
  assert.equal(beforeDeadline.reviewWindowDays, 3);
  assert.equal(Payroll.resolvePeriodReviewWindow(closedAt, "2026-10-18T21:00:01Z", 3).state, "confirmation-required");
});

test("calcula fechas administrativas 18/3 en America/New_York, incluido el cambio de año", () => {
  assert.equal(Payroll.automaticPayrollMarkDate(2026, 10, 1), "2026-10-18");
  assert.equal(Payroll.automaticPayrollMarkDate(2026, 10, 2), "2026-11-03");
  assert.equal(Payroll.automaticPayrollMarkDate(2026, 12, 2), "2027-01-03");
  assert.equal(Payroll.automaticPayrollMarkDate(2026, 13, 1), null);
});

test("planifica solo asignaciones del snapshot cerrado, con idempotencia y auditoría", () => {
  const snapshot = closedSnapshot();
  const before = JSON.stringify(snapshot);
  const result = Payroll.planAutomaticPaymentBatch({
    period: { year: 2026, month: 10, half: 1 },
    snapshot,
    now: "2026-10-19T03:59:00Z",
    timeZone: "America/New_York",
    executionLocalTime: "23:59",
    reviewWindowDays: 3,
    currentRows: [{ assignmentId: "future-row-not-in-snapshot", role: "TP", amount: 500, paymentState: "unpaid" }]
  });
  assert.equal(result.state, "ready-to-apply");
  assert.equal(result.scheduledDate, "2026-10-18");
  assert.deepEqual(result.actions.map(action => [action.assignmentId, action.role, action.amount, action.paidFlagColumn]), [
    ["fixture-assignment-1", "TP", 180, "AF"],
    ["fixture-assignment-2", "TA1", 130, "AG"]
  ]);
  assert.equal(result.actions[0].idempotencyKey, "payroll-auto:2026-10-Q1:fixture-assignment-1");
  assert.equal(result.actions[0].paidFlagBefore, false);
  assert.equal(result.actions[0].paidFlagAfter, true);
  assert.equal(result.actions[0].origin, "automatic-calendar-policy");
  assert.equal(result.actions[0].bankTransferVerified, false);
  assert.deepEqual(result.actions[0].audit.before, { paidFlag: false });
  assert.deepEqual(result.actions[0].audit.after, { paidFlag: true });
  assert.deepEqual(result.skipped.map(item => item.reason), ["already-marked", "zero-amount"]);
  assert.equal(JSON.stringify(snapshot), before);

  const retried = Payroll.planAutomaticPaymentBatch({
    period: { year: 2026, month: 10, half: 1 }, snapshot: closedSnapshot({ assignments: [
      { assignmentId: "fixture-assignment-1", periodKey: "2026-10-Q1", role: "TP", amount: 180, eligible: true, paymentState: "paid" }
    ] }),
    now: "2026-10-19T03:59:00Z", timeZone: "America/New_York", executionLocalTime: "23:59", reviewWindowDays: 3,
    processedLedger: [{ idempotencyKey: "payroll-auto:2026-10-Q1:fixture-assignment-1", status: "applied" }]
  });
  assert.equal(retried.state, "no-pending-assignments");
  assert.equal(retried.actions.length, 0);
  assert.equal(retried.skipped[0].reason, "already-applied");
});

test("bloquea lotes sin cierre congelado, ids estables, revisión completa o ejecución puntual", () => {
  const base = {
    period: { year: 2026, month: 10, half: 1 }, now: "2026-10-19T03:59:00Z",
    timeZone: "America/New_York", executionLocalTime: "23:59", reviewWindowDays: 3
  };
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: null }).state, "blocked-review");
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot({ frozen: false }) }).state, "blocked-review");
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot({ frozenAt: "2026-10-19T01:00:00Z" }) }).state, "blocked-review");
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot({ assignments: [
    { assignmentId: "", periodKey: "2026-10-Q1", role: "TP", amount: 180, eligible: true, paymentState: "unpaid" }
  ] }) }).actions.length, 0);
  const needsReview = Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot({ assignments: [
    { assignmentId: "fixture-valid-first", periodKey: "2026-10-Q1", role: "TP", amount: 180, eligible: true, paymentState: "unpaid" },
    { assignmentId: "fixture-review-second", periodKey: "2026-10-Q1", role: "TA1", amount: 130, eligible: true, paymentState: "review" }
  ] }) });
  assert.equal(needsReview.state, "blocked-review");
  assert.equal(needsReview.actions.length, 0);
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot(), now: "2026-10-18T20:59:00Z" }).state, "not-due-time");
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot({ closedAt: "2026-10-15T23:59:00-04:00" }), now: "2026-10-19T03:59:00Z" }).state, "finance-review-window-open");
  assert.equal(Payroll.planAutomaticPaymentBatch({ ...base, snapshot: closedSnapshot(), now: "2026-10-20T03:59:00Z" }).state, "missed-run-review");
});

test("planea archivo y regeneración desde lectura fresca, con preview antes de reemplazar", () => {
  const first = Payroll.planInvoiceArchive(archiveFixture());
  assert.equal(first.state, "ready-to-archive");
  assert.equal(first.operation, "create-file");
  assert.equal(first.target.folderPath, "NOMINAS/2026/OCTUBRE/Technician A");
  assert.equal(first.target.fileName, "Technician A - 1RA QUINCENA OCTUBRE 2026.pdf");
  assert.equal(first.nextVersion, 1);
  assert.equal(first.sendsEmail, false);
  assert.equal(first.changePaymentFlags, false);

  const newLines = [invoiceFixtureLine({ amount: 200, paidState: "paid" })];
  const existingFile = {
    fileId: "fixture-drive-file-id", version: 1, folio: "fixture-old-folio",
    revisionRetentionSupported: true, lines: [invoiceFixtureLine()]
  };
  const needsApproval = Payroll.planInvoiceArchive(archiveFixture({ currentLines: newLines, existingFile }));
  assert.equal(needsApproval.state, "changes-require-approval");
  assert.ok(needsApproval.changes[0].changedFields.includes("amount"));
  assert.ok(needsApproval.changes[0].changedFields.includes("paidState"));
  assert.equal(needsApproval.operation, null);

  const approved = Payroll.planInvoiceArchive(archiveFixture({ currentLines: newLines, existingFile, approveChanges: true, deliveryMode: "drive-and-resend" }));
  assert.equal(approved.state, "ready-to-archive");
  assert.equal(approved.operation, "replace-existing-file");
  assert.equal(approved.fileId, existingFile.fileId);
  assert.equal(approved.nextVersion, 2);
  assert.equal(approved.keepDriveRevision, true);
  assert.equal(approved.deliveryMode, "drive-and-resend");
  assert.equal(approved.sendsEmail, false);
  assert.equal(approved.changePaymentFlags, false);

  assert.equal(Payroll.planInvoiceArchive(archiveFixture({ sourceReadAt: "2026-10-18T23:40:00-04:00" })).blocked[0], "sheet-read-is-stale");
  assert.equal(Payroll.planInvoiceArchive(archiveFixture({ currentLines: [invoiceFixtureLine({ assignmentId: "" })] })).blocked[0], "current-lines-need-stable-identities");
  assert.equal(Payroll.planInvoiceArchive(archiveFixture({ existingFile: { ...existingFile, revisionRetentionSupported: false } })).blocked[0], "drive-revision-retention-not-confirmed");
});

test("separa la vista previa y reintento de correo del archivo y del pago", () => {
  const archive = { status: "stored", fileId: "fixture-drive-file-id", version: 2, folio: "fixture-folio-v2" };
  const recipient = {
    technicianId: "fixture-technician-id", email: "tech@example.test", active: true, verified: true,
    verifiedAt: "2026-10-18T20:00:00Z", directoryVersion: "fixture-directory-v1"
  };
  const preview = Payroll.planInvoiceDelivery({ deliveryMode: "drive-and-resend", technicianId: "fixture-technician-id", archive, recipient });
  assert.equal(preview.state, "recipient-preview-required");
  assert.equal(preview.preview.email, "tech@example.test");
  assert.equal(preview.idempotencyKey, "payroll-email:fixture-drive-file-id:v2:fixture-technician-id");
  assert.equal(preview.sendEmail, false);
  assert.equal(preview.regenerateDriveFile, false);
  assert.equal(preview.changePaymentFlags, false);

  const send = Payroll.planInvoiceDelivery({ deliveryMode: "drive-and-resend", technicianId: "fixture-technician-id", archive, recipient, approved: true });
  assert.equal(send.state, "ready-to-send");
  assert.equal(send.sendEmail, false);
  const failed = Payroll.planInvoiceDelivery({ deliveryMode: "drive-and-resend", technicianId: "fixture-technician-id", archive, recipient, priorDelivery: { idempotencyKey: send.idempotencyKey, state: "failed-no-send" }, approved: true });
  assert.equal(failed.state, "ready-to-send");
  assert.equal(failed.operation, "retry-email-only");
  assert.equal(failed.regenerateDriveFile, false);
  const uncertain = Payroll.planInvoiceDelivery({ deliveryMode: "drive-and-resend", technicianId: "fixture-technician-id", archive, recipient, priorDelivery: { idempotencyKey: send.idempotencyKey, state: "unknown" }, approved: true });
  assert.equal(uncertain.state, "reconcile-delivery-before-retry");
  assert.equal(uncertain.sendEmail, false);
  const sent = Payroll.planInvoiceDelivery({ deliveryMode: "drive-and-resend", technicianId: "fixture-technician-id", archive, recipient, priorDelivery: { idempotencyKey: send.idempotencyKey, state: "sent" }, approved: true });
  assert.equal(sent.state, "already-sent");
  assert.equal(sent.sendEmail, false);
  assert.equal(Payroll.planInvoiceDelivery({ deliveryMode: "drive-only", technicianId: "fixture-technician-id", archive, recipient }).state, "drive-only");
  assert.equal(Payroll.planInvoiceDelivery({ deliveryMode: "drive-and-resend", technicianId: "another-technician", archive, recipient }).state, "blocked-review");
});

test("el folio es estable al reimprimir el mismo snapshot y cambia con sus importes", () => {
  const lines = Payroll.buildAssignments([row()]).lines;
  const first = Payroll.folio("Technician A", 2026, 10, 1, lines);
  assert.equal(Payroll.folio("Technician A", 2026, 10, 1, lines), first);
  assert.notEqual(Payroll.folio("Technician A", 2026, 10, 1, lines.map(line => ({ ...line, amount: line.amount + 1 }))), first);
});

