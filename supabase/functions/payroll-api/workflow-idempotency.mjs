const JOB_TYPES = new Set(["period_close", "invoice_drive", "invoice_email", "calendar_mark"]);
const STATES = new Set(["queued", "running", "succeeded", "failed", "unknown", "needs_review"]);
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-Q[12]$/;

function requiredText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function normalizeJobIdentity(input) {
  if (!input || !JOB_TYPES.has(input.jobType) || !PERIOD.test(input.periodKey || "")) return null;
  const identity = { jobType: input.jobType, periodKey: input.periodKey };
  if (["invoice_drive", "invoice_email"].includes(input.jobType)) {
    if (!requiredText(input.technicianId) || !requiredText(input.version)) return null;
    identity.technicianId = input.technicianId.trim();
    identity.version = input.version.trim();
    if (input.jobType === "invoice_email") {
      if (!requiredText(input.deliveryAttemptId)) return null;
      identity.deliveryAttemptId = input.deliveryAttemptId.trim();
    }
  }
  if (input.jobType === "calendar_mark") {
    if (!requiredText(input.assignmentId)) return null;
    identity.assignmentId = input.assignmentId.trim();
  }
  if (input.jobType === "period_close" && !requiredText(input.snapshotId)) return null;
  if (input.jobType === "period_close") identity.snapshotId = input.snapshotId.trim();
  return identity;
}

export async function makeWorkflowIdempotencyKey(input, cryptoImpl = globalThis.crypto) {
  const identity = normalizeJobIdentity(input);
  if (!identity || !cryptoImpl?.subtle?.digest) return null;
  const canonical = JSON.stringify(Object.keys(identity).sort().map(key => [key, identity[key]]));
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `lrs:${input.jobType}:${toBase64Url(digest)}`;
}

export function classifyWorkflowAttempt({ idempotencyKey, jobType, requestDigest, existing }) {
  if (!requiredText(idempotencyKey) || idempotencyKey.length > 240 || !JOB_TYPES.has(jobType) ||
      !/^[a-f0-9]{64}$/.test(requestDigest || "")) {
    return { decision: "reject", reason: "invalid_job_identity" };
  }
  if (!existing) return { decision: "enqueue", state: "queued" };
  if (existing.idempotency_key !== idempotencyKey || existing.job_type !== jobType || existing.request_digest !== requestDigest) {
    return { decision: "conflict", reason: "idempotency_key_payload_mismatch" };
  }
  if (!STATES.has(existing.state)) return { decision: "reconcile", reason: "unknown_stored_state" };
  if (existing.state === "succeeded") return { decision: "return_existing_result", state: "succeeded" };
  if (existing.state === "queued" || existing.state === "running") return { decision: "wait", state: existing.state };
  if (existing.state === "unknown" || existing.state === "needs_review") return { decision: "reconcile", state: existing.state };
  return { decision: "manual_retry_review", state: "failed" };
}

export function mayTransitionWorkflowState(from, to, { reconciled = false, retryApproved = false } = {}) {
  if (!STATES.has(from) || !STATES.has(to) || from === to || from === "succeeded") return false;
  if (["unknown", "needs_review"].includes(from) && !reconciled) return false;
  const transitions = {
    queued: new Set(["running", "failed", "needs_review"]),
    running: new Set(["succeeded", "failed", "unknown", "needs_review"]),
    failed: new Set(["queued"]),
    unknown: new Set(["succeeded", "failed", "needs_review"]),
    needs_review: new Set(["queued", "running", "succeeded", "failed"])
  };
  if (!transitions[from]?.has(to)) return false;
  if (to === "queued" && !retryApproved) return false;
  return true;
}
