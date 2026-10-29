(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PayrollCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const SLOT_DEFS = [
    ["tp", "TP"],
    ["ta1", "TA1"],
    ["ta2", "TA2"]
  ];

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizedText(value) {
    return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[\s_-]+/g, " ").trim();
  }

  function normalizeStatus(value) {
    const status = normalizedText(value);
    if (["COMPLETE", "COMPLETADO", "COMPLETADA"].includes(status)) return "COMPLETED";
    if (["CANCELLED", "CANCELADO", "CANCELADA"].includes(status)) return "CANCELED";
    if (["INPROGRESS", "IN PROCESS", "EN PROGRESO"].includes(status)) return "IN PROGRESS";
    if (status === "PENDIENTE") return "PENDING";
    return status;
  }

  function parseHalf(value) {
    const period = normalizedText(value);
    if (/^(?:1|1A|1RA|PRIMERA)(?:\s|$)/.test(period)) return 1;
    if (/^(?:2|2A|2DA|SEGUNDA)(?:\s|$)/.test(period)) return 2;
    return null;
  }

  function parseDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    }
    const raw = text(value);
    const gviz = raw.match(/^Date\((\d+),(\d+),(\d+)\)/);
    if (gviz) return `${gviz[1]}-${String(Number(gviz[2]) + 1).padStart(2, "0")}-${String(gviz[3]).padStart(2, "0")}`;
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}-${String(us[2]).padStart(2, "0")}`;
    return "";
  }

  function parseAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const raw = text(value);
    if (!raw) return 0;
    const negative = /^\(.*\)$/.test(raw);
    const n = Number.parseFloat(raw.replace(/[,$\s()]/g, ""));
    if (!Number.isFinite(n)) return 0;
    return negative ? -Math.abs(n) : n;
  }

  function paidState(value) {
    if (value === true) return "paid";
    if (value === false || value == null || text(value) === "") return "unpaid";
    if (typeof value === "number") return value === 0 ? "unpaid" : "paid";
    const v = normalizedText(value);
    if (["TRUE", "YES", "SI", "PAGADO", "PAGADA", "PAID", "DONE", "X", "1", "✓", "✔"].includes(v)) return "paid";
    if (["FALSE", "NO", "PENDIENTE", "UNPAID", "0"].includes(v)) return "unpaid";
    return "review";
  }

  function isReportComplete(value) {
    return ["TRUE", "YES", "SI", "1", "OK", "SENT", "DELIVERED", "COMPLETED", "DONE", "ENVIADO", "ENVIADA"].includes(normalizedText(value));
  }

  function currentNYPeriod(now) {
    const date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    const day = Number(part("day"));
    return { year: Number(part("year")), month: Number(part("month")), half: day <= 15 ? 1 : 2 };
  }

  function resolvePeriodReviewWindow(closedAt, now, reviewWindowDays) {
    const closeText = text(closedAt);
    const hasOffset = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(closeText);
    const closeMs = hasOffset ? Date.parse(closeText) : NaN;
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(text(now));
    const base = {
      closedAt: Number.isFinite(closeMs) ? new Date(closeMs).toISOString() : null,
      reviewUntil: null,
      reviewWindowDays: Number.isInteger(reviewWindowDays) && reviewWindowDays >= 0 ? reviewWindowDays : null,
      periodVisible: true,
      financeReviewWindowOpen: null,
      autoMarkPaid: false
    };

    if (!closeText) return { ...base, state: "awaiting-close-record" };
    if (!Number.isFinite(closeMs)) return { ...base, state: "invalid-close-record" };
    if (base.reviewWindowDays == null) return { ...base, state: "configuration-required" };
    if (!Number.isFinite(nowMs)) return { ...base, state: "clock-required" };

    const reviewUntilMs = closeMs + reviewWindowDays * 24 * 60 * 60 * 1000;
    const state = nowMs < closeMs ? "scheduled" : nowMs <= reviewUntilMs ? "finance-review" : "confirmation-required";
    return {
      ...base,
      state,
      reviewUntil: new Date(reviewUntilMs).toISOString(),
      financeReviewWindowOpen: state === "finance-review"
    };
  }

  function automaticPayrollMarkDate(year, month, half) {
    const y = Number(year), m = Number(month), h = Number(half);
    if (!Number.isInteger(y) || y < 2000 || !Number.isInteger(m) || m < 1 || m > 12 || ![1, 2].includes(h)) return null;
    if (h === 1) return `${y}-${String(m).padStart(2, "0")}-18`;
    const nextYear = m === 12 ? y + 1 : y;
    const nextMonth = m === 12 ? 1 : m + 1;
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-03`;
  }

  function payrollLocalDate(value, timeZone) {
    const date = value instanceof Date ? value : new Date(Date.parse(text(value)));
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function payrollLocalTime(value, timeZone) {
    const date = value instanceof Date ? value : new Date(Date.parse(text(value)));
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part("hour")}:${part("minute")}`;
  }

  function planAutomaticPaymentBatch(options) {
    const input = options || {};
    const period = input.period || {};
    const timeZone = input.timeZone || "America/New_York";
    const year = Number(period.year), month = Number(period.month), half = Number(period.half);
    const targetKey = Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(half)
      ? periodKey(year, month, half) : "";
    const scheduledDate = automaticPayrollMarkDate(year, month, half);
    const executionLocalTime = text(input.executionLocalTime);
    const base = { periodKey: targetKey, scheduledDate, timeZone, executionLocalTime, actions: [], skipped: [], blocked: [] };
    const blocked = reason => ({ ...base, state: "blocked-review", actions: [], skipped: [], blocked: [reason] });
    if (!scheduledDate) return blocked("invalid-period");
    if (timeZone !== "America/New_York") return blocked("unsupported-time-zone");
    if (!Number.isInteger(input.reviewWindowDays) || input.reviewWindowDays < 0) return blocked("review-window-not-configured");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(executionLocalTime)) return blocked("execution-time-not-configured");
    const nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(text(input.now));
    const today = payrollLocalDate(Number.isFinite(nowMs) ? new Date(nowMs) : "", timeZone);
    if (!today) return blocked("invalid-clock");
    if (!input.snapshot) return blocked("missing-closed-snapshot");
    const snapshot = input.snapshot;
    const closedAt = text(snapshot.closedAt), frozenAt = text(snapshot.frozenAt);
    const timestampHasZone = value => /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
    const closedMs = timestampHasZone(closedAt) ? Date.parse(closedAt) : NaN;
    const frozenMs = timestampHasZone(frozenAt) ? Date.parse(frozenAt) : NaN;
    if (!snapshot.snapshotId || snapshot.frozen !== true || snapshot.periodKey !== targetKey || !Number.isFinite(closedMs) || !Number.isFinite(frozenMs)) {
      return blocked("snapshot-not-closed-and-frozen-for-period");
    }
    if (closedMs > frozenMs || frozenMs > nowMs) return blocked("snapshot-timestamp-review");
    if (payrollLocalDate(new Date(closedMs), timeZone) >= scheduledDate || payrollLocalDate(new Date(frozenMs), timeZone) >= scheduledDate) {
      return blocked("snapshot-closed-too-late-for-calendar-run");
    }
    if (today < scheduledDate) return { ...base, state: "not-due" };
    if (today > scheduledDate) return { ...base, state: "missed-run-review", blocked: ["scheduled-date-passed"] };
    if (payrollLocalTime(new Date(nowMs), timeZone) < executionLocalTime) return { ...base, state: "not-due-time" };
    const window = resolvePeriodReviewWindow(closedAt, new Date(nowMs), input.reviewWindowDays);
    if (window.state !== "confirmation-required") return { ...base, state: "finance-review-window-open", blocked: ["review-window-not-elapsed"] };

    const assignments = snapshot.assignments;
    if (!Array.isArray(assignments) || !assignments.length) return blocked("snapshot-has-no-eligible-assignments");
    const seenIds = new Set();
    for (const assignment of assignments) {
      const id = text(assignment && assignment.assignmentId);
      const role = normalizedText(assignment && assignment.role);
      if (!id || seenIds.has(id) || assignment.periodKey !== targetKey || assignment.eligible !== true || !["TP", "TA1", "TA2"].includes(role)) {
        return blocked("assignment-id-period-or-role-review");
      }
      seenIds.add(id);
      if (typeof assignment.amount !== "number" || !Number.isFinite(assignment.amount) || assignment.amount < 0) {
        return blocked("assignment-amount-review");
      }
    }

    const ledger = Array.isArray(input.processedLedger) ? input.processedLedger : [];
    for (const assignment of assignments) {
      const id = text(assignment.assignmentId), role = normalizedText(assignment.role);
      if (assignment.amount === 0) {
        base.skipped.push({ assignmentId: id, reason: "zero-amount" });
        continue;
      }
      if (!["unpaid", "paid", "review"].includes(assignment.paymentState)) return blocked("payment-state-review");
      if (assignment.paymentState === "review") return blocked("payment-flag-needs-review");
      const idempotencyKey = `payroll-auto:${targetKey}:${id}`;
      const prior = ledger.filter(entry => entry && entry.idempotencyKey === idempotencyKey);
      if (prior.length > 1) return blocked("duplicate-idempotency-record");
      if (prior.length === 1) {
        if (prior[0].status !== "applied" || assignment.paymentState !== "paid") return blocked("ledger-sheet-state-conflict");
        base.skipped.push({ assignmentId: id, reason: "already-applied" });
        continue;
      }
      if (assignment.paymentState === "paid") {
        base.skipped.push({ assignmentId: id, reason: "already-marked" });
        continue;
      }
      base.actions.push({
        periodKey: targetKey,
        scheduledDate,
        snapshotId: snapshot.snapshotId,
        assignmentId: id,
        role,
        paidFlagColumn: ({ TP: "AF", TA1: "AG", TA2: "AH" })[role],
        amount: assignment.amount,
        idempotencyKey,
        paidFlagBefore: false,
        paidFlagAfter: true,
        origin: "automatic-calendar-policy",
        bankTransferVerified: false,
        audit: {
          source: "automatic-calendar-policy",
          snapshotId: snapshot.snapshotId,
          before: { paidFlag: false },
          after: { paidFlag: true },
          bankTransferVerified: false
        }
      });
    }
    return { ...base, state: base.actions.length ? "ready-to-apply" : "no-pending-assignments" };
  }

  function payrollArchiveTarget(year, month, half, technicianName) {
    const y = Number(year), m = Number(month), h = Number(half);
    const technician = text(technicianName).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
    if (!Number.isInteger(y) || y < 2000 || !Number.isInteger(m) || m < 1 || m > 12 || ![1, 2].includes(h) || !technician) return null;
    const monthFolder = MONTHS[m - 1].toLocaleUpperCase("es");
    const halfLabel = h === 1 ? "1RA QUINCENA" : "2DA QUINCENA";
    return {
      folderPath: `NOMINAS/${y}/${monthFolder}/${technician}`,
      fileName: `${technician} - ${halfLabel} ${monthFolder} ${y}.pdf`
    };
  }

  function planInvoiceArchive(options) {
    const input = options || {}, period = input.period || {};
    const year = Number(period.year), month = Number(period.month), half = Number(period.half);
    const deliveryMode = input.deliveryMode || "drive-only";
    const targetKey = Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(half)
      ? periodKey(year, month, half) : "";
    const target = payrollArchiveTarget(year, month, half, input.technicianName);
    const base = {
      periodKey: targetKey,
      target,
      changes: [],
      operation: null,
      nextVersion: null,
      deliveryMode,
      sendsEmail: false,
      changePaymentFlags: false
    };
    const blocked = (state, reason, changes = []) => ({ ...base, state, blocked: [reason], changes, operation: null });
    if (!targetKey || !target) return blocked("blocked-review", "invalid-period-or-technician");
    if (!["drive-only", "drive-and-resend"].includes(deliveryMode)) return blocked("blocked-review", "invalid-delivery-choice");
    if (!text(input.technicianId)) return blocked("blocked-review", "missing-stable-technician-id");
    if (input.periodClosed !== true || input.closedPeriodKey !== targetKey || !text(input.closedSnapshotId)) {
      return blocked("blocked-review", "missing-closed-period-snapshot");
    }
    if (!text(input.freshSnapshotId)) return blocked("blocked-review", "missing-fresh-sheet-snapshot");
    const nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(text(input.now));
    const sourceReadAt = text(input.sourceReadAt);
    const readMs = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(sourceReadAt) ? Date.parse(sourceReadAt) : NaN;
    if (!Number.isFinite(nowMs) || !Number.isFinite(readMs) || !Number.isInteger(input.maxSourceAgeSeconds) || input.maxSourceAgeSeconds < 0) {
      return blocked("blocked-review", "invalid-fresh-read-metadata");
    }
    const ageMs = nowMs - readMs;
    if (ageMs < 0 || ageMs > input.maxSourceAgeSeconds * 1000) return blocked("blocked-review", "sheet-read-is-stale");

    const lines = input.currentLines;
    if (!Array.isArray(lines) || !lines.length) return blocked("blocked-review", "no-current-invoice-lines");
    const validateLines = candidate => {
      if (!Array.isArray(candidate)) return null;
      const seen = new Set();
      for (const line of candidate) {
        const id = text(line && line.assignmentId);
        const role = normalizedText(line && line.role);
        if (!id || seen.has(id) || line.technicianId !== text(input.technicianId) || !["TP", "TA1", "TA2"].includes(role) ||
            line.periodKey !== targetKey || typeof line.amount !== "number" || !Number.isFinite(line.amount) ||
            !["paid", "unpaid", "review", "zero"].includes(line.paidState)) return null;
        seen.add(id);
      }
      return seen;
    };
    if (!validateLines(lines)) return blocked("blocked-review", "current-lines-need-stable-identities");

    const existing = input.existingFile || null;
    const closedLines = input.closedSnapshotLines;
    if (!Array.isArray(closedLines) || !closedLines.length) return blocked("blocked-review", "closed-snapshot-lines-required");
    if (existing && (!text(existing.fileId) || !Number.isInteger(existing.version) || existing.version < 1 || !text(existing.folio))) {
      return blocked("blocked-review", "existing-drive-ledger-incomplete");
    }
    if (existing && existing.revisionRetentionSupported !== true) return blocked("blocked-review", "drive-revision-retention-not-confirmed");
    if (!validateLines(closedLines)) return blocked("blocked-review", "closed-snapshot-lines-need-stable-identities");
    if (existing && (!Array.isArray(existing.lines) || !validateLines(existing.lines))) return blocked("blocked-review", "existing-file-lines-need-stable-identities");

    const fields = ["role", "amount", "paidState", "date", "project", "client", "activity", "caseName", "jobStatus"];
    const changes = [];
    const compareLines = (baseline, source) => {
      const before = new Map(baseline.map(line => [text(line.assignmentId), line]));
      const after = new Map(lines.map(line => [text(line.assignmentId), line]));
      for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const oldLine = before.get(id) || null, newLine = after.get(id) || null;
        const changedFields = oldLine && newLine
          ? fields.filter(field => (oldLine[field] ?? null) !== (newLine[field] ?? null))
          : oldLine ? ["removed"] : ["added"];
        if (changedFields.length) changes.push({ assignmentId: id, source, changedFields });
      }
    };
    compareLines(closedLines, "closed-snapshot");
    if (existing) compareLines(existing.lines, "current-drive-version");
    if (changes.length && input.approveChanges !== true) {
      return blocked("changes-require-approval", "invoice-diff-needs-admin-preview", changes);
    }
    const invoiceFolio = folio(input.technicianName, year, month, half, lines);
    const version = existing ? existing.version + 1 : 1;
    return {
      ...base,
      state: "ready-to-archive",
      blocked: [],
      changes,
      operation: existing ? "replace-existing-file" : "create-file",
      fileId: existing ? existing.fileId : null,
      nextVersion: version,
      folio: invoiceFolio,
      closedSnapshotId: input.closedSnapshotId,
      freshSnapshotId: input.freshSnapshotId,
      sourceReadAt: new Date(readMs).toISOString(),
      keepDriveRevision: !!existing,
      sendsEmail: false,
      changePaymentFlags: false,
      audit: {
        operation: existing ? "regenerate" : "generate",
        previousFolio: existing ? existing.folio : null,
        newFolio: invoiceFolio,
        approvedChanges: changes.length > 0,
        deliveryMode,
        paymentFlagsChanged: false,
        emailSent: false
      }
    };
  }

  function planInvoiceDelivery(options) {
    const input = options || {}, archive = input.archive || {}, recipient = input.recipient || {};
    const technicianId = text(input.technicianId);
    const base = {
      fileId: text(archive.fileId) || null,
      version: archive.version || null,
      folio: text(archive.folio) || null,
      sendEmail: false,
      regenerateDriveFile: false,
      changePaymentFlags: false,
      idempotencyKey: null,
      preview: null
    };
    const blocked = reason => ({ ...base, state: "blocked-review", blocked: [reason] });
    if (input.deliveryMode === "drive-only") return { ...base, state: "drive-only", blocked: [] };
    if (input.deliveryMode !== "drive-and-resend") return blocked("invalid-delivery-choice");
    if (archive.status !== "stored" || !base.fileId || !Number.isInteger(base.version) || base.version < 1 || !base.folio) {
      return blocked("drive-update-not-confirmed");
    }
    const verifiedAt = text(recipient.verifiedAt);
    const verifiedTimestamp = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(verifiedAt) ? Date.parse(verifiedAt) : NaN;
    const email = text(recipient.email);
    if (recipient.technicianId !== technicianId || recipient.active !== true || recipient.verified !== true ||
        !Number.isFinite(verifiedTimestamp) || !text(recipient.directoryVersion) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return blocked("recipient-not-verified-for-technician");
    }
    const idempotencyKey = `payroll-email:${base.fileId}:v${base.version}:${technicianId}`;
    const preview = {
      technicianId,
      email,
      fileId: base.fileId,
      version: base.version,
      folio: base.folio,
      directoryVersion: recipient.directoryVersion,
      verifiedAt: new Date(verifiedTimestamp).toISOString()
    };
    const prior = input.priorDelivery || null;
    if (prior && prior.idempotencyKey !== idempotencyKey) return blocked("delivery-ledger-key-mismatch");
    if (prior && prior.directoryVersion && prior.directoryVersion !== recipient.directoryVersion) return blocked("recipient-directory-changed-since-attempt");
    if (prior && prior.state === "sent") return { ...base, state: "already-sent", blocked: [], idempotencyKey, preview };
    if (prior && ["unknown", "sending"].includes(prior.state)) {
      return { ...base, state: "reconcile-delivery-before-retry", blocked: ["provider-result-not-settled"], idempotencyKey, preview };
    }
    if (prior && prior.state !== "failed-no-send") return blocked("delivery-ledger-review");
    const retryOnly = !!prior;
    if (input.approved !== true) {
      return {
        ...base,
        state: "recipient-preview-required",
        blocked: [],
        operation: retryOnly ? "retry-email-only" : "send-after-archive",
        idempotencyKey,
        preview,
        approvalRequired: true
      };
    }
    return {
      ...base,
      state: "ready-to-send",
      blocked: [],
      operation: retryOnly ? "retry-email-only" : "send-after-archive",
      idempotencyKey,
      preview,
      approvalRequired: false
    };
  }

  function periodKey(year, month, half) {
    return `${year}-${String(month).padStart(2, "0")}-Q${half}`;
  }

  function periodLabel(year, month, half) {
    return `${half === 1 ? "1.ª" : "2.ª"} quincena de ${MONTHS[month - 1]} ${year}`;
  }

  function cleanTechnician(value) {
    const name = text(value);
    const key = normalizedText(name);
    if (!name || ["-", "—", "N/A", "NA", "SIN ASIGNAR", "UNASSIGNED", "NONE"].includes(key)) return "";
    return name;
  }

  function buildAssignments(rows) {
    const lines = [];
    const unassigned = [];
    const reviewRows = [];
    let excludedStatus = 0;

    (Array.isArray(rows) ? rows : []).forEach((source, index) => {
      const row = source || {};
      const date = parseDate(row.date);
      const year = date ? Number(date.slice(0, 4)) : null;
      const month = date ? Number(date.slice(5, 7)) : null;
      const half = parseHalf(row.period);
      const status = normalizeStatus(row.status);
      const category = normalizedText(row.category);
      const slots = SLOT_DEFS.map(([key, role]) => ({
        key,
        role,
        technician: cleanTechnician(row[key]),
        amount: parseAmount(row[`amount${key.toUpperCase()}`]),
        paidState: paidState(row[`paid${key.toUpperCase()}`])
      }));
      const hasSupportedCancellationFee = status === "CANCELED" && category === "NEW" && slots.some(slot => slot.amount > 0);
      const eligibleStatus = status === "COMPLETED" || status === "REALIZADO" || hasSupportedCancellationFee;

      if (!eligibleStatus) {
        excludedStatus++;
        return;
      }
      if (!date || !half) {
        reviewRows.push({ date, period: text(row.period), status, reason: !date ? "missing-date" : "missing-period" });
        return;
      }

      const rowInfo = {
        date,
        year,
        month,
        half,
        periodKey: periodKey(year, month, half),
        periodLabel: periodLabel(year, month, half),
        category: text(row.category),
        project: text(row.project || row.client),
        client: text(row.client || row.project),
        activity: text(row.activity),
        caseName: text(row.caseName || row.case),
        jobStatus: status,
        reportStatus: text(row.report),
        reportPending: status === "REALIZADO" && !isReportComplete(row.report),
        cancellationFee: hasSupportedCancellationFee
      };

      slots.forEach(slot => {
        if (hasSupportedCancellationFee && slot.amount <= 0) return;
        if (!slot.technician) {
          if (slot.amount !== 0) unassigned.push({ ...rowInfo, role: slot.role, amount: slot.amount });
          return;
        }
        lines.push({
          ...rowInfo,
          id: `${index}-${slot.key}`,
          role: slot.role,
          technician: slot.technician,
          amount: slot.amount,
          paidState: slot.amount === 0 ? "zero" : slot.paidState,
          paid: slot.amount !== 0 && slot.paidState === "paid"
        });
      });
    });

    return { lines, unassigned, reviewRows, excludedStatus };
  }

  function filterAssignments(lines, filters) {
    const f = filters || {};
    const from = parseDate(f.from);
    const to = parseDate(f.to);
    if (from && to && from > to) return [];
    const match = (value, expected) => !expected || normalizedText(value) === normalizedText(expected);
    const search = text(f.project).toLocaleLowerCase();
    return (Array.isArray(lines) ? lines : []).filter(line =>
      (!f.year || Number(f.year) === line.year) &&
      (!f.month || Number(f.month) === line.month) &&
      (!f.half || Number(f.half) === line.half) &&
      (!from || line.date >= from) &&
      (!to || line.date <= to) &&
      match(line.technician, f.technician) &&
      match(line.role, f.role) &&
      match(line.activity, f.activity) &&
      match(line.caseName, f.caseName) &&
      (!search || `${line.project} ${line.client}`.toLocaleLowerCase().includes(search)) &&
      match(line.jobStatus, f.jobStatus) &&
      (!f.paymentStatus || f.paymentStatus === "all" || line.paidState === f.paymentStatus)
    );
  }

  function summarize(lines) {
    const summaries = new Map();
    (Array.isArray(lines) ? lines : []).forEach(line => {
      const key = line.technician;
      if (!summaries.has(key)) summaries.set(key, {
        technician: key,
        total: 0,
        paid: 0,
        pending: 0,
        review: 0,
        lineCount: 0,
        projects: new Set(),
        reportPending: 0
      });
      const summary = summaries.get(key);
      summary.total += line.amount;
      summary.lineCount++;
      summary.projects.add(`${line.date}|${line.project}|${line.activity}|${line.caseName}`);
      if (line.paidState === "paid") summary.paid += line.amount;
      else if (line.paidState === "unpaid") summary.pending += line.amount;
      else if (line.paidState === "review") summary.review += line.amount;
      if (line.reportPending) summary.reportPending++;
    });
    return [...summaries.values()].map(summary => ({ ...summary, projects: summary.projects.size, balance: summary.total - summary.paid }))
      .sort((a, b) => a.technician.localeCompare(b.technician, "es"));
  }

  function folio(technician, year, month, half, lines) {
    const canonical = (Array.isArray(lines) ? lines : []).map(line => [
      line.date, line.project, line.activity, line.caseName, line.role,
      Number(line.amount), line.paidState, line.jobStatus, line.reportPending ? 1 : 0
    ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const payload = JSON.stringify([technician, year, month, half, canonical]);
    let hash = 2166136261;
    for (let i = 0; i < payload.length; i++) hash = Math.imul(hash ^ payload.charCodeAt(i), 16777619) >>> 0;
    const slug = normalizedText(technician).replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12) || "TECNICO";
    return `NOM-${year}${String(month).padStart(2, "0")}-Q${half}-${slug}-${hash.toString(16).padStart(8, "0").toUpperCase()}`;
  }

  return {
    buildAssignments,
    currentNYPeriod,
    filterAssignments,
    folio,
    isReportComplete,
    normalizeStatus,
    automaticPayrollMarkDate,
    payrollLocalDate,
    payrollLocalTime,
    payrollArchiveTarget,
    planInvoiceArchive,
    planInvoiceDelivery,
    planAutomaticPaymentBatch,
    paidState,
    parseAmount,
    parseDate,
    parseHalf,
    periodKey,
    periodLabel,
    resolvePeriodReviewWindow,
    summarize
  };
});
