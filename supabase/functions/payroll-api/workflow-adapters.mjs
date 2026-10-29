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

export function validateClosedPayrollSnapshot(snapshot) {
  return validateSnapshot(snapshot);
}
async function digestPayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function digestBytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function executeIdempotent({ jobs, audit, key, type, periodKey, identityRef, payload, origin = "user", actorId = null, execute, now = new Date() }) {
  requireAdapter(jobs, "get");
  requireAdapter(jobs, "insertQueued");
  requireAdapter(jobs, "transition");
  requireAdapter(audit, "record");
  const digest = await digestPayload(payload);
  let prior = await jobs.get(key);
  const decision = classifyWorkflowAttempt({ idempotencyKey: key, jobType: type, requestDigest: digest, existing: prior });
  const auditEvent = { idempotencyKey: key, origin, actorId, action: type, entityType: type, entityRef: identityRef, periodKey, outcome: "succeeded" };
  if (decision.decision === "return_existing_result") {
    let auditPending = false;
    try { await audit.record(auditEvent); } catch (_) { auditPending = true; }
    return { state: "succeeded", result: prior.result_payload ?? null, replay: true, auditPending };
  }
  if (prior && ["conflict", "reject"].includes(decision.decision)) {
    return { state: decision.state || "conflict", reason: decision.reason || "idempotency_conflict", replay: true };
  }
  let claimed = false;
  if (prior) {
    if (prior.state === "queued") {
      const leaseMs = Date.parse(prior.lease_expires_at || "");
      const nowMs = new Date(now).getTime();
      if (!Number.isFinite(leaseMs) || leaseMs > nowMs || typeof jobs.claimExpiredQueued !== "function") {
        return { state: "queued", reason: "job_lease_active_or_unavailable", replay: true };
      }
      const startedAt = new Date(nowMs).toISOString();
      const leaseExpiresAt = new Date(nowMs + 120_000).toISOString();
      try { claimed = await jobs.claimExpiredQueued(key, { expectedLeaseExpiresAt: prior.lease_expires_at, startedAt, leaseExpiresAt }); }
      catch (_) { return { state: "reconcile_required", reason: "expired_queue_claim_unavailable", replay: true }; }
      if (!claimed) {
        const raced = await jobs.get(key);
        return { state: raced?.state === "running" ? "reconcile_required" : raced?.state || "queued", reason: "expired_queue_claim_conflict", replay: true };
      }
    } else if (decision.decision !== "enqueue") {
      const state = ["running", "unknown", "needs_review"].includes(prior.state)
        ? "reconcile_required"
        : decision.state || decision.decision;
      return { state, reason: decision.reason || null, replay: true };
    }
  }

  if (!prior) {
    const leaseExpiresAt = new Date(new Date(now).getTime() + 120_000).toISOString();
    const inserted = await jobs.insertQueued({
      idempotency_key: key, job_type: type, period_key: periodKey, request_digest: digest,
      technician_id: payload.technicianId || null,
      source_snapshot_ref: payload.snapshotId || null,
      requested_by: actorId, lease_expires_at: leaseExpiresAt
    });
    if (!inserted) {
      const raced = await jobs.get(key);
      if (!raced && type === "invoice_email" && typeof jobs.findUnresolvedEmail === "function") {
        const unresolved = await jobs.findUnresolvedEmail({ periodKey, technicianId: payload.technicianId });
        if (Array.isArray(unresolved) && unresolved.length) return { state: "reconcile_required", reason: "previous_email_outcome_unresolved", replay: true };
      }
      const afterRace = classifyWorkflowAttempt({ idempotencyKey: key, jobType: type, requestDigest: digest, existing: raced });
      return { state: raced?.state === "running" ? "reconcile_required" : afterRace.state || afterRace.decision, reason: afterRace.reason || "concurrent_job", replay: true };
    }
    const startedAt = new Date(now).toISOString();
    try {
      await jobs.transition(key, "running", { started_at: startedAt, lease_expires_at: leaseExpiresAt }, { expectedState: "queued" });
      claimed = true;
    } catch (_) {
      // The transition response may be lost after the database committed. This
      // invocation created the queued record and is the only claimant before
      // the lease expires, so a matching running row is safe to continue.
      try {
        prior = await jobs.get(key);
        claimed = prior?.state === "running" && prior.started_at === startedAt;
      } catch (_) { claimed = false; }
      if (!claimed) return { state: prior?.state === "running" ? "reconcile_required" : "queued", reason: "job_start_persistence_uncertain", idempotencyKey: key };
    }
  }
  if (!claimed) return { state: "reconcile_required", reason: "job_claim_not_confirmed", idempotencyKey: key };
  let result;
  try {
    result = await execute();
  } catch (error) {
    const state = error?.outcomeUnknown === true ? "unknown" : error?.reviewRequired === true ? "needs_review" : "failed";
    try { await jobs.transition(key, state, { result_code: state, completed_at: new Date(now).toISOString() }, { expectedState: "running" }); } catch (_) { /* A running job is reconciled; it is never retried automatically. */ }
    try { await audit.record({ ...auditEvent, outcome: state }); } catch (_) { /* Audit repair is separate from provider retry. */ }
    return { state, reason: "operation_failed", idempotencyKey: key };
  }
  try {
    await jobs.transition(key, "succeeded", { result_code: "ok", result_payload: result, completed_at: new Date(now).toISOString() }, { expectedState: "running" });
  } catch (_) {
    try { await jobs.transition(key, "unknown", { result_code: "provider_succeeded_result_unpersisted", completed_at: new Date(now).toISOString() }, { expectedState: "running" }); } catch (_) { /* The running record remains reconciliation-only. */ }
    return { state: "reconcile_required", reason: "provider_succeeded_result_persistence_failed", idempotencyKey: key };
  }
  let auditPending = false;
  try { await audit.record(auditEvent); } catch (_) { auditPending = true; }
  return { state: "succeeded", result, idempotencyKey: key, auditPending };
}

export async function reconcileWorkflowAttempt({ jobs, audit, idempotencyKey, jobType, requestDigest, lookupProviderResult, auditEvent, now = new Date() }) {
  requireAdapter(jobs, "get");
  requireAdapter(jobs, "transition");
  requireAdapter(lookupProviderResult, "lookup");
  const current = await jobs.get(idempotencyKey);
  const decision = classifyWorkflowAttempt({ idempotencyKey, jobType, requestDigest, existing: current });
  if (!current || !["running", "unknown", "needs_review"].includes(current.state)) {
    return { state: decision.state || decision.decision, replay: true, result: current?.result_payload ?? null };
  }
  let provider;
  try { provider = await lookupProviderResult.lookup({ idempotencyKey, job: current }); }
  catch (_) { return { state: "reconcile_required", reason: "provider_lookup_failed", replay: true }; }
  if (provider?.state === "succeeded" && provider.result) {
    await jobs.transition(idempotencyKey, "succeeded", {
      result_code: "reconciled",
      result_payload: provider.result,
      reconciled_at: new Date(now).toISOString()
    }, { reconciled: true, expectedState: current.state });
    if (audit && auditEvent) {
      try { await audit.record({ ...auditEvent, outcome: "succeeded" }); }
      catch (_) { return { state: "succeeded", result: provider.result, replay: true, auditPending: true }; }
    }
    return { state: "succeeded", result: provider.result, replay: true, reconciled: true };
  }
  if (provider?.state === "not_performed" && provider.definitive === true) {
    await jobs.transition(idempotencyKey, "failed", {
      result_code: "provider_confirmed_not_performed",
      reconciled_at: new Date(now).toISOString()
    }, { reconciled: true, expectedState: current.state });
    return { state: "failed", reason: "provider_confirmed_not_performed", replay: true };
  }
  return { state: "reconcile_required", reason: "provider_outcome_unsettled", replay: true };
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

export async function archiveClosedInvoice({ snapshot: rawSnapshot, technicianId, technicianName, pdfBytes, freshSourceRevision, drive, jobs, audit, actorId = null }) {
  const snapshot = validateSnapshot(rawSnapshot);
  if (freshSourceRevision !== snapshot.sourceRevision) throw new TypeError("source_changed_since_snapshot_review_required");
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length < 5 || String.fromCharCode(...pdfBytes.slice(0, 5)) !== "%PDF-") {
    throw new TypeError("pdf_bytes_required");
  }
  if (!snapshot.lines.some(line => line.technicianId === technicianId)) throw new TypeError("technician_not_in_snapshot");
  requireAdapter(drive, "findCurrentInvoice");
  const identity = { jobType: "invoice_drive", periodKey: snapshot.periodKey, technicianId, version: snapshot.sourceRevision };
  const key = await makeWorkflowIdempotencyKey(identity);
  const pdfSha256 = await digestBytes(pdfBytes);
  const payload = { ...identity, snapshotId: snapshot.id, pdfSha256 };
  const names = invoiceNames(snapshot, technicianId, technicianName);
  return executeIdempotent({
    jobs, audit, key, type: "invoice_drive", periodKey: snapshot.periodKey,
    identityRef: `${snapshot.id}:${technicianId}`, payload, actorId,
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
        return {
          state: "stored", fileId: replaced.fileId, revisionId: replaced.revisionId,
          sourceRevision: snapshot.sourceRevision, snapshotId: snapshot.id, technicianId,
          periodKey: snapshot.periodKey, pdfSha256, fileName: names.fileName, folderPath: names.folderPath, replaced: true
        };
      }
      requireAdapter(drive, "createInvoice");
      const created = await drive.createInvoice({
        content: pdfBytes, fileName: names.fileName, folderPath: names.folderPath, idempotencyKey: key,
        metadata: { periodKey: snapshot.periodKey, technicianId, snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision }
      });
      if (!created?.fileId || !created.revisionId) throw new Error("drive_create_unverified");
      return {
        state: "stored", fileId: created.fileId, revisionId: created.revisionId,
        sourceRevision: snapshot.sourceRevision, snapshotId: snapshot.id, technicianId,
        periodKey: snapshot.periodKey, pdfSha256, fileName: names.fileName, folderPath: names.folderPath, replaced: false
      };
    }
  });
}

export async function sendVerifiedInvoice({ snapshot: rawSnapshot, technicianId, archivedFile, pdfBytes, recipientDirectory, mailer, previewVerifier, previewToken, jobs, audit, actorId = null }) {
  const snapshot = validateSnapshot(rawSnapshot);
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length < 5 || String.fromCharCode(...pdfBytes.slice(0, 5)) !== "%PDF-") throw new TypeError("pdf_bytes_required");
  if (!snapshot.lines.some(line => line.technicianId === technicianId)) throw new TypeError("technician_not_in_snapshot");
  if (!archivedFile || archivedFile.state !== "stored" || typeof archivedFile.fileId !== "string" ||
      typeof archivedFile.revisionId !== "string" || archivedFile.snapshotId !== snapshot.id ||
      archivedFile.technicianId !== technicianId || archivedFile.periodKey !== snapshot.periodKey ||
      archivedFile.sourceRevision !== snapshot.sourceRevision) {
    throw new TypeError("verified_archived_file_required");
  }
  const pdfSha256 = await digestBytes(pdfBytes);
  if (archivedFile.pdfSha256 !== pdfSha256) throw new TypeError("archived_pdf_content_mismatch");
  requireAdapter(recipientDirectory, "resolve");
  requireAdapter(mailer, "send");
  requireAdapter(previewVerifier, "verify");
  requireAdapter(jobs, "findUnresolvedEmail");
  const recipient = await recipientDirectory.resolve(technicianId);
  if (!recipient || recipient.active !== true || recipient.verified !== true || recipient.technicianId !== technicianId ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email || "") ||
      typeof recipient.directoryVersion !== "string" || !recipient.directoryVersion.trim()) {
    throw new TypeError("verified_recipient_required");
  }
  const approval = await previewVerifier.verify({
    token: previewToken, periodKey: snapshot.periodKey, sourceRevision: snapshot.sourceRevision,
    snapshotId: snapshot.id,
    technicianId,
    archive: { fileId: archivedFile.fileId, revisionId: archivedFile.revisionId, pdfSha256: archivedFile.pdfSha256 },
    recipient: { directoryId: recipient.directoryId, directoryVersion: recipient.directoryVersion, email: recipient.email },
    actorId
  });
  const deliveryAttemptId = approval?.deliveryAttemptId;
  if (!approval || approval.approved !== true || typeof deliveryAttemptId !== "string" ||
      !deliveryAttemptId.trim() || approval.binding?.snapshotId !== snapshot.id ||
      approval.binding?.sourceRevision !== snapshot.sourceRevision ||
      approval.binding?.technicianId !== technicianId ||
      approval.binding?.fileId !== archivedFile.fileId ||
      approval.binding?.revisionId !== archivedFile.revisionId ||
      approval.binding?.pdfSha256 !== archivedFile.pdfSha256 ||
      approval.binding?.recipientDirectoryId !== recipient.directoryId ||
      approval.binding?.directoryVersion !== recipient.directoryVersion ||
      approval.binding?.recipientEmail !== recipient.email ||
      approval.binding?.actorId !== actorId) {
    throw new TypeError("recipient_preview_approval_required");
  }
  const identity = { jobType: "invoice_email", periodKey: snapshot.periodKey, technicianId, version: snapshot.sourceRevision, deliveryAttemptId };
  const key = await makeWorkflowIdempotencyKey(identity);
  const payload = {
    ...identity, recipientId: recipient.directoryId, directoryVersion: recipient.directoryVersion,
    fileId: archivedFile.fileId, fileRevisionId: archivedFile.revisionId, pdfSha256
  };
  const unresolved = await jobs.findUnresolvedEmail({ periodKey: snapshot.periodKey, technicianId });
  if (!Array.isArray(unresolved)) throw new TypeError("email_job_lookup_invalid");
  if (unresolved.length) return { state: "reconcile_required", reason: "previous_email_outcome_unresolved", replay: true };
  return executeIdempotent({
    jobs, audit, key, type: "invoice_email", periodKey: snapshot.periodKey,
    identityRef: `${snapshot.id}:${technicianId}:${deliveryAttemptId}`, payload, actorId,
    origin: "user",
    execute: async () => {
      const result = await mailer.send({
        to: recipient.email, subject: `Invoice de nómina · ${snapshot.periodKey}`,
        attachment: pdfBytes, idempotencyKey: key,
        fileName: archivedFile.fileName || `NOMINA-${snapshot.periodKey}.pdf`,
        archive: { fileId: archivedFile.fileId, revisionId: archivedFile.revisionId, pdfSha256 },
        recipientDirectoryId: recipient.directoryId
      });
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
  const closedMs = Date.parse(snapshot.closedAt || "");
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(closedMs) || !Number.isFinite(nowMs)) return { state: "needs_review", reason: "snapshot_close_time_missing", changed: 0 };
  if (nowMs < closedMs + 72 * 60 * 60 * 1000) return { state: "needs_review", reason: "finance_review_window_open", changed: 0 };
  const changes = snapshot.lines.filter(line => line.amount > 0);
  if (changes.some(line => typeof line.paidFlag !== "boolean")) return { state: "needs_review", reason: "payment_flag_unknown", changed: 0 };
  requireAdapter(writer, "preflightClosedSnapshot");
  let preflight;
  try { preflight = await writer.preflightClosedSnapshot({ snapshot }); }
  catch (_) { return { state: "needs_review", reason: "sheet_preflight_failed", changed: 0 }; }
  if (preflight?.state !== "ready") return { state: "needs_review", reason: preflight?.reason || "sheet_preflight_failed", changed: 0 };
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
          technicianId: line.technicianId, sheetMetadataId: line.sheetMetadataId,
          sourceFingerprintHash: line.sourceFingerprintHash, amount: line.amount, periodKey: line.periodKey,
          snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision, dueDate, idempotencyKey: key,
          origin: "automatic-calendar-policy"
        });
        if (written?.outcomeUnknown === true) { const error = new Error("sheet_write_unverified"); error.outcomeUnknown = true; throw error; }
        if (written?.conflict === true) { const error = new Error("sheet_manual_conflict"); error.reviewRequired = true; throw error; }
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
