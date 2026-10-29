import { classifyWorkflowAttempt, makeWorkflowIdempotencyKey } from "./workflow-idempotency.mjs";

const MONTHS = Object.freeze(["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"]);
const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])-Q([12])$/;

function requireAdapter(adapter, method) {
  if (!adapter || typeof adapter[method] !== "function") throw new TypeError(`adapter_required:${method}`);
}
function safePathSegment(value) {
  const segment = String(value ?? "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ");
  if (!segment || segment === "." || segment === "..") throw new TypeError("invalid_path_segment");
  return segment.slice(0, 80);
}
function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.state !== "closed" || snapshot.frozen !== true ||
      typeof snapshot.id !== "string" || !snapshot.id.trim() || !PERIOD.test(snapshot.periodKey || "") ||
      typeof snapshot.sourceRevision !== "string" || !snapshot.sourceRevision.trim() ||
      typeof snapshot.frozenAt !== "string" || !Number.isFinite(Date.parse(snapshot.frozenAt)) ||
      !Array.isArray(snapshot.lines)) {
    throw new TypeError("frozen_closed_snapshot_required");
  }
  const ids = new Set();
  for (const line of snapshot.lines) {
    if (!line || typeof line.assignmentId !== "string" || !line.assignmentId.trim() ||
        typeof line.technicianId !== "string" || !line.technicianId.trim() ||
        !["TP", "TA1", "TA2"].includes(line.role) ||
        !Number.isFinite(line.amount) || line.amount < 0 || ids.has(`${line.assignmentId}:${line.role}`)) {
      throw new TypeError("invalid_snapshot_assignment");
    }
    ids.add(`${line.assignmentId}:${line.role}`);
  }
  return snapshot;
}
async function digestPayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function executeIdempotent({ jobs, audit, key, type, periodKey, identityRef, payload, origin = "user", execute }) {
  requireAdapter(jobs, "get");
  requireAdapter(jobs, "insertQueued");
  requireAdapter(jobs, "transition");
  requireAdapter(audit, "record");
  const digest = await digestPayload(payload);
  const prior = await jobs.get(key);
  const decision = classifyWorkflowAttempt({ idempotencyKey: key, jobType: type, requestDigest: digest, existing: prior });
  if (decision.decision !== "enqueue") return { state: decision.state || decision.decision, reason: decision.reason || null, replay: true };
  const inserted = await jobs.insertQueued({ idempotency_key: key, job_type: type, period_key: periodKey, request_digest: digest });
  if (!inserted) {
    const raced = await jobs.get(key);
    const afterRace = classifyWorkflowAttempt({ idempotencyKey: key, jobType: type, requestDigest: digest, existing: raced });
    return { state: afterRace.state || afterRace.decision, reason: afterRace.reason || "concurrent_job", replay: true };
  }
  await jobs.transition(key, "running");
  try {
    const result = await execute();
    await jobs.transition(key, "succeeded", { result_code: "ok" });
    await audit.record({ idempotencyKey: key, origin, action: type, entityType: type, entityRef: identityRef, periodKey, outcome: "succeeded" });
    return { state: "succeeded", result, idempotencyKey: key };
  } catch (error) {
    const state = error?.outcomeUnknown === true ? "unknown" : "failed";
    await jobs.transition(key, state, { result_code: state });
    await audit.record({ idempotencyKey: key, origin, action: type, entityType: type, entityRef: identityRef, periodKey, outcome: state });
    return { state, reason: "operation_failed", idempotencyKey: key };
  }
}

function invoiceNames(snapshot, technicianId, technicianName) {
  const match = PERIOD.exec(snapshot.periodKey);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const half = Number(match[3]);
  const safeName = safePathSegment(technicianName);
  const halfLabel = half === 1 ? "1RA" : "2DA";
  const fileName = `${safeName} - ${halfLabel} QUINCENA ${year}-${String(month).padStart(2, "0")}.pdf`;
  return { fileName, folderPath: `NOMINAS/${year}/${MONTHS[month - 1]}/${safeName}`, technicianId };
}

export async function archiveClosedInvoice({ snapshot: rawSnapshot, technicianId, technicianName, pdfBytes, freshSourceRevision, drive, jobs, audit }) {
  const snapshot = validateSnapshot(rawSnapshot);
  if (freshSourceRevision !== snapshot.sourceRevision) throw new TypeError("source_changed_since_snapshot_review_required");
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length < 5 || String.fromCharCode(...pdfBytes.slice(0, 5)) !== "%PDF-") {
    throw new TypeError("pdf_bytes_required");
  }
  if (!snapshot.lines.some(line => line.technicianId === technicianId)) throw new TypeError("technician_not_in_snapshot");
  requireAdapter(drive, "findCurrentInvoice");
  const identity = { jobType: "invoice_drive", periodKey: snapshot.periodKey, technicianId, version: snapshot.sourceRevision };
  const key = await makeWorkflowIdempotencyKey(identity);
  const payload = { ...identity, snapshotId: snapshot.id, pdfSha256: await digestPayload([...pdfBytes]) };
  const names = invoiceNames(snapshot, technicianId, technicianName);
  return executeIdempotent({
    jobs, audit, key, type: "invoice_drive", periodKey: snapshot.periodKey,
    identityRef: `${snapshot.id}:${technicianId}`, payload,
    execute: async () => {
      const current = await drive.findCurrentInvoice({ technicianId, periodKey: snapshot.periodKey });
      if (current) {
        requireAdapter(drive, "replacePreservingRevision");
        const replaced = await drive.replacePreservingRevision({
          fileId: current.fileId, expectedRevisionId: current.revisionId, content: pdfBytes,
          fileName: names.fileName, folderPath: names.folderPath, idempotencyKey: key,
          metadata: { periodKey: snapshot.periodKey, technicianId, snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision }
        });
        if (!replaced?.fileId || replaced.fileId !== current.fileId || !replaced.revisionId) throw new Error("drive_replace_unverified");
        return { fileId: replaced.fileId, revisionId: replaced.revisionId, fileName: names.fileName, folderPath: names.folderPath, replaced: true };
      }
      requireAdapter(drive, "createInvoice");
      const created = await drive.createInvoice({
        content: pdfBytes, fileName: names.fileName, folderPath: names.folderPath, idempotencyKey: key,
        metadata: { periodKey: snapshot.periodKey, technicianId, snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision }
      });
      if (!created?.fileId || !created.revisionId) throw new Error("drive_create_unverified");
      return { fileId: created.fileId, revisionId: created.revisionId, fileName: names.fileName, folderPath: names.folderPath, replaced: false };
    }
  });
}

export async function sendVerifiedInvoice({ snapshot: rawSnapshot, technicianId, deliveryAttemptId, pdfBytes, recipientDirectory, mailer, previewVerifier, previewToken, jobs, audit }) {
  const snapshot = validateSnapshot(rawSnapshot);
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length < 5 || String.fromCharCode(...pdfBytes.slice(0, 5)) !== "%PDF-") throw new TypeError("pdf_bytes_required");
  if (!snapshot.lines.some(line => line.technicianId === technicianId)) throw new TypeError("technician_not_in_snapshot");
  requireAdapter(recipientDirectory, "resolve");
  requireAdapter(mailer, "send");
  requireAdapter(previewVerifier, "verify");
  const recipient = await recipientDirectory.resolve(technicianId);
  if (!recipient || recipient.active !== true || recipient.verified !== true || recipient.technicianId !== technicianId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email || "")) {
    throw new TypeError("verified_recipient_required");
  }
  const approval = await previewVerifier.verify({
    token: previewToken, periodKey: snapshot.periodKey, sourceRevision: snapshot.sourceRevision,
    technicianId, recipientDirectoryId: recipient.directoryId, deliveryAttemptId
  });
  if (!approval || approval.approved !== true) throw new TypeError("recipient_preview_approval_required");
  const identity = { jobType: "invoice_email", periodKey: snapshot.periodKey, technicianId, version: snapshot.sourceRevision, deliveryAttemptId };
  const key = await makeWorkflowIdempotencyKey(identity);
  const payload = { ...identity, recipientId: recipient.directoryId, pdfSha256: await digestPayload([...pdfBytes]) };
  return executeIdempotent({
    jobs, audit, key, type: "invoice_email", periodKey: snapshot.periodKey,
    identityRef: `${snapshot.id}:${technicianId}:${deliveryAttemptId}`, payload,
    execute: async () => {
      const result = await mailer.send({ to: recipient.email, subject: `Invoice de nómina · ${snapshot.periodKey}`, attachment: pdfBytes, idempotencyKey: key });
      if (!result?.messageId) {
        const error = new Error("email_result_unverified");
        error.outcomeUnknown = result?.outcomeUnknown === true;
        throw error;
      }
      return { messageId: result.messageId, recipientId: recipient.directoryId };
    }
  });
}

export function scheduledAdministrativeMarkDate(periodKey) {
  const match = PERIOD.exec(String(periodKey || ""));
  if (!match) throw new TypeError("invalid_period");
  let year = Number(match[1]);
  let month = Number(match[2]);
  if (Number(match[3]) === 2) {
    month++;
    if (month > 12) { month = 1; year++; }
    return `${year}-${String(month).padStart(2, "0")}-03`;
  }
  return `${year}-${String(month).padStart(2, "0")}-18`;
}

function newYorkDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function executeScheduledAdministrativeMarks({ snapshot: rawSnapshot, now = new Date(), writer, jobs, audit }) {
  const snapshot = validateSnapshot(rawSnapshot);
  requireAdapter(writer, "setPaidFlagByStableAssignmentId");
  const dueDate = scheduledAdministrativeMarkDate(snapshot.periodKey);
  if (newYorkDate(now) !== dueDate) return { state: "not_due", dueDate, changed: 0 };
  if (newYorkDate(new Date(snapshot.frozenAt)) > dueDate) return { state: "needs_review", reason: "snapshot_closed_after_due_date", changed: 0 };
  const changes = snapshot.lines.filter(line => line.amount > 0);
  if (changes.some(line => typeof line.paidFlag !== "boolean")) return { state: "needs_review", reason: "payment_flag_unknown", changed: 0 };
  let changed = 0;
  const results = [];
  for (const line of changes) {
    if (line.paidFlag === true) { results.push({ state: "already_marked" }); continue; }
    const identity = { jobType: "calendar_mark", periodKey: snapshot.periodKey, assignmentId: `${line.assignmentId}:${line.role}` };
    const key = await makeWorkflowIdempotencyKey(identity);
    const payload = { ...identity, snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision, paidFlagBefore: false, dueDate };
    const result = await executeIdempotent({
      jobs, audit, key, type: "calendar_mark", periodKey: snapshot.periodKey,
      identityRef: `${snapshot.id}:${line.assignmentId}:${line.role}`, payload, origin: "automatic-calendar-policy",
      execute: async () => {
        const written = await writer.setPaidFlagByStableAssignmentId({
          assignmentId: line.assignmentId, role: line.role, expectedPaidFlag: false, paidFlag: true,
          snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision, dueDate, idempotencyKey: key
        });
        if (written?.outcomeUnknown === true) { const error = new Error("sheet_write_unverified"); error.outcomeUnknown = true; throw error; }
        if (written?.updated !== true) throw new Error("sheet_write_not_applied");
        return { assignmentId: line.assignmentId, role: line.role, origin: "automatic-calendar-policy" };
      }
    });
    results.push(result);
    if (result.state === "succeeded") changed++;
    if (result.state === "unknown" || result.state === "failed") return { state: result.state, dueDate, changed, results };
  }
  return { state: "succeeded", dueDate, changed, results };
}
