import { archiveClosedInvoice, sendVerifiedInvoice, validateClosedPayrollSnapshot } from "./workflow-adapters.mjs";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-Q[12]$/;
const ACTION_FIELDS = Object.freeze({
  "invoice.archive": ["action", "operation", "periodKey", "snapshotId", "technicianId"],
  "invoice.retry-preview": ["action", "periodKey", "snapshotId", "technicianId"],
  "invoice.send-confirm": ["action", "periodKey", "snapshotId", "technicianId", "previewToken"],
  "invoice.retry-confirm": ["action", "periodKey", "snapshotId", "technicianId", "previewToken"]
});

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function response(status, body) { return { status, body: { schema: 1, ...body } }; }
function digestHex(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then(digest =>
    [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
  );
}
function isScopeAllowed(access, technicianId) {
  return access.scope_mode === "all" ||
    (access.scope_mode === "selected" && Array.isArray(access.technician_ids) && access.technician_ids.includes(technicianId));
}
function hasCapability(access, action) {
  if (!access || access.is_active !== true || access.can_view_payroll !== true) return false;
  if (["invoice.archive", "invoice.retry-preview"].includes(action)) return access.can_generate_invoice === true;
  return access.can_send_invoice === true;
}
function validRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.action !== "string") return false;
  const fields = ACTION_FIELDS[body.action];
  if (!fields || Object.keys(body).some(key => !fields.includes(key))) return false;
  if (!PERIOD.test(body.periodKey || "") || !text(body.snapshotId) || text(body.snapshotId).length > 160 ||
      !text(body.technicianId) || text(body.technicianId).length > 160) return false;
  if (body.action === "invoice.archive" && !["drive-only", "drive-and-send"].includes(body.operation)) return false;
  if (body.action !== "invoice.archive" && body.operation !== undefined) return false;
  if (["invoice.send-confirm", "invoice.retry-confirm"].includes(body.action) && (!text(body.previewToken) || body.previewToken.length > 4096)) return false;
  return true;
}
function requireDependencies(deps, action) {
  const required = ["snapshotStore", "sourceReader", "identityResolver", "buildInvoice", "renderPdf", "drive", "jobs", "audit"];
  if (["invoice.send-confirm", "invoice.retry-confirm", "invoice.retry-preview"].includes(action)) {
    required.push("recipientDirectory", "previewSigner", "previewVerifier", "mailer", "jobs.findUnresolvedEmail");
  }
  return required.every(key => key.includes(".")
    ? typeof deps[key.split(".")[0]]?.[key.split(".")[1]] === "function"
    : Boolean(deps[key]));
}

export function createPayrollWorkflowHandler(dependencies = {}) {
  return async function handlePayrollWorkflow({ body, access = dependencies.access, actorId = dependencies.actorId } = {}) {
    if (!validRequest(body)) return response(400, { error: "invalid_request" });
    if (!hasCapability(access, body.action)) return response(403, { error: "not_authorized" });
    const technicianId = text(body.technicianId);
    if (!isScopeAllowed(access, technicianId)) return response(403, { error: "technician_scope_denied" });
    if (dependencies.enabled !== true) return response(503, { error: "payroll_workflows_not_configured" });
    if (!requireDependencies(dependencies, body.action)) return response(503, { error: "payroll_workflow_provider_not_configured" });

    try {
      const snapshot = validateClosedPayrollSnapshot(await dependencies.snapshotStore.getClosedSnapshot({
        periodKey: body.periodKey, snapshotId: body.snapshotId
      }));
      if (snapshot.periodKey !== body.periodKey || snapshot.id !== body.snapshotId) return response(409, { error: "closed_snapshot_mismatch" });
      if (!snapshot.lines.some(line => line.technicianId === technicianId)) return response(404, { error: "technician_not_in_snapshot" });

      const identities = await dependencies.identityResolver(snapshot.lines);
      if (!Array.isArray(identities) || identities.length !== snapshot.lines.length ||
          identities.some((item, index) => item?.state !== "verified" || item.assignmentId !== snapshot.lines[index].assignmentId)) {
        return response(409, { error: "stable_assignment_identity_review_required" });
      }
      const freshSourceRevision = await dependencies.sourceReader.getRevision({ periodKey: body.periodKey });
      if (freshSourceRevision !== snapshot.sourceRevision) return response(409, { error: "source_changed_since_close_review_required" });

      const invoice = await dependencies.buildInvoice(snapshot, technicianId);
      if (!invoice || invoice.periodKey !== snapshot.periodKey || invoice.technicianId !== technicianId ||
          !Array.isArray(invoice.lines) || invoice.lines.length === 0 || invoice.lines.some(line => line.technicianId !== technicianId)) {
        return response(409, { error: "server_invoice_projection_invalid" });
      }
      const pdfBytes = await dependencies.renderPdf(invoice);
      if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length < 5 || String.fromCharCode(...pdfBytes.slice(0, 5)) !== "%PDF-") {
        return response(503, { error: "invoice_renderer_unavailable" });
      }

      if (body.action === "invoice.archive") {
        const archived = await archiveClosedInvoice({ snapshot, technicianId, technicianName: invoice.technician,
          pdfBytes, freshSourceRevision, drive: dependencies.drive, jobs: dependencies.jobs,
          audit: dependencies.audit, actorId });
        if (archived.state !== "succeeded") return response(409, { state: archived.state, error: "drive_operation_requires_reconciliation" });
        if (body.operation === "drive-only") return response(200, { state: "archived", drive: archived.result, auditPending: archived.auditPending === true });
        const preview = await issueSendPreview({ dependencies, snapshot, technicianId, invoice, pdfBytes, archivedFile: archived.result, actorId });
        return preview.status === 200
          ? response(200, { state: "confirmation_required", drive: archived.result, emailPreview: preview.body })
          : preview;
      }

      if (body.action === "invoice.retry-preview") {
        const current = await dependencies.drive.getCurrentInvoice({ periodKey: snapshot.periodKey, technicianId });
        const preview = await issueSendPreview({ dependencies, snapshot, technicianId, invoice, pdfBytes, archivedFile: current, actorId });
        return preview.status === 200 ? response(200, { state: "confirmation_required", emailPreview: preview.body }) : preview;
      }

      const current = await dependencies.drive.getCurrentInvoice({ periodKey: snapshot.periodKey, technicianId });
      const pdfSha256 = await digestHex(pdfBytes);
      if (!current || current.state !== "stored" || current.snapshotId !== snapshot.id || current.periodKey !== snapshot.periodKey ||
          current.technicianId !== technicianId || current.sourceRevision !== snapshot.sourceRevision || current.pdfSha256 !== pdfSha256) {
        return response(409, { error: "current_archive_does_not_match_preview" });
      }
      const email = await sendVerifiedInvoice({ snapshot, technicianId, archivedFile: current, pdfBytes,
        recipientDirectory: dependencies.recipientDirectory, mailer: dependencies.mailer,
        previewVerifier: dependencies.previewVerifier, previewToken: body.previewToken,
        jobs: dependencies.jobs, audit: dependencies.audit, actorId });
      if (email.state !== "succeeded") return response(email.state === "unknown" || email.state === "reconcile_required" ? 409 : 502,
        { state: email.state, error: "email_operation_requires_reconciliation" });
      return response(200, { state: "sent", email: { state: email.state, result: email.result, auditPending: email.auditPending === true } });
    } catch (error) {
      const code = error instanceof Error ? error.message : "workflow_failed";
      if (code === "source_changed_since_snapshot_review_required") return response(409, { error: "source_changed_since_close_review_required" });
      if (code === "verified_archived_file_required" || code === "archived_pdf_content_mismatch" || code === "recipient_preview_approval_required") {
        return response(409, { error: "archive_or_recipient_approval_changed" });
      }
      if (code === "adapter_required:findCurrentInvoice" || code.startsWith("adapter_required:")) return response(503, { error: "payroll_workflow_provider_not_configured" });
      return response(503, { error: "payroll_workflow_unavailable" });
    }
  };
}

async function issueSendPreview({ dependencies, snapshot, technicianId, invoice, pdfBytes, archivedFile, actorId }) {
  if (typeof dependencies.jobs?.findUnresolvedEmail !== "function") return response(503, { error: "payroll_workflow_provider_not_configured" });
  const unresolved = await dependencies.jobs.findUnresolvedEmail({ periodKey: snapshot.periodKey, technicianId });
  if (!Array.isArray(unresolved)) return response(503, { error: "payroll_workflow_provider_not_configured" });
  if (unresolved.length) return response(409, { error: "previous_email_outcome_requires_reconciliation" });
  const pdfSha256 = await digestHex(pdfBytes);
  if (!archivedFile || archivedFile.state !== "stored" || !archivedFile.fileId || !archivedFile.revisionId ||
      archivedFile.snapshotId !== snapshot.id || archivedFile.periodKey !== snapshot.periodKey ||
      archivedFile.technicianId !== technicianId || archivedFile.sourceRevision !== snapshot.sourceRevision || archivedFile.pdfSha256 !== pdfSha256) {
    return response(409, { error: "current_archive_does_not_match_invoice" });
  }
  const recipient = await dependencies.recipientDirectory.resolve(technicianId);
  if (!recipient || recipient.active !== true || recipient.verified !== true || recipient.technicianId !== technicianId ||
      !recipient.directoryId || !recipient.directoryVersion || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email || "")) {
    return response(409, { error: "verified_recipient_required" });
  }
  const binding = {
    periodKey: snapshot.periodKey, snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision,
    technicianId, fileId: archivedFile.fileId, revisionId: archivedFile.revisionId, pdfSha256,
    recipientDirectoryId: recipient.directoryId, directoryVersion: recipient.directoryVersion,
    recipientEmail: recipient.email, actorId
  };
  const issued = await dependencies.previewSigner.issue(binding);
  if (!issued?.token || !issued.deliveryAttemptId || !issued.expiresAt) return response(503, { error: "recipient_preview_unavailable" });
  return response(200, {
    recipient: recipient.email,
    token: issued.token,
    expiresAt: issued.expiresAt,
    archive: { fileId: archivedFile.fileId, revisionId: archivedFile.revisionId, pdfSha256 },
    technician: invoice.technician,
    periodKey: snapshot.periodKey
  });
}
