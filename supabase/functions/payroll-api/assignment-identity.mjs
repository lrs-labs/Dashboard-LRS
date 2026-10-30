import { sha256Hex } from "../../../stable-json.mjs";

const ROLES = new Set(["TP", "TA1", "TA2"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function prepare(line) {
  if (!line || typeof line !== "object") return { state: "unresolved", reason: "source_line_invalid" };
  const eventRef = text(line.eventRef);
  const technicianId = text(line.technicianId);
  const role = text(line.role).toUpperCase();
  if (!eventRef) return { state: "unresolved", reason: "stable_event_reference_required" };
  if (!technicianId) return { state: "unresolved", reason: "stable_technician_id_required" };
  if (!ROLES.has(role)) return { state: "unresolved", reason: "assignment_role_invalid" };
  if (typeof line.amount !== "number" || !Number.isFinite(line.amount) || line.amount < 0) {
    return { state: "unresolved", reason: "assignment_amount_invalid" };
  }
  const values = {
    eventRef,
    periodKey: text(line.periodKey),
    date: text(line.date),
    project: text(line.project),
    client: text(line.client),
    caseName: text(line.caseName),
    activity: text(line.activity),
    technicianId,
    role
  };
  if (!values.periodKey || !values.date || !values.project || !values.caseName || !values.activity) {
    return { state: "unresolved", reason: "assignment_fingerprint_fields_missing" };
  }
  return {
    values,
    amount: line.amount,
    status: text(line.jobStatus).toUpperCase(),
    cancellationFee: line.cancellationFee === true
  };
}

export async function calculateAssignmentHashes(line) {
  const value = prepare(line);
  if (!value.values) return value;
  const identityKeyHash = await sha256Hex(value.values);
  const sourceFingerprintHash = await sha256Hex({
    ...value.values,
    amount: value.amount,
    status: value.status,
    cancellationFee: value.cancellationFee
  });
  return { ...value, identityKeyHash, sourceFingerprintHash };
}

function resolved(assignmentId, identityKeyHash, sourceFingerprintHash, sheetMetadataId = null) {
  return { state: "verified", assignmentId, identityKeyHash, sourceFingerprintHash, sheetMetadataId, reason: null };
}

function review(state, identityKeyHash, sourceFingerprintHash, reason) {
  return { state, assignmentId: null, identityKeyHash, sourceFingerprintHash, reason };
}

export async function resolveAssignmentIdentities(lines, { store, createId = () => globalThis.crypto?.randomUUID?.() } = {}) {
  if (!store || typeof store.findByIdentityHash !== "function" || typeof store.createPending !== "function") {
    throw new TypeError("private_assignment_identity_store_required");
  }
  if (!Array.isArray(lines)) throw new TypeError("source_lines_required");

  const prepared = await Promise.all(lines.map(calculateAssignmentHashes));
  const occurrences = new Map();
  for (const item of prepared) {
    if (item.identityKeyHash) occurrences.set(item.identityKeyHash, (occurrences.get(item.identityKeyHash) || 0) + 1);
  }

  return Promise.all(prepared.map(async item => {
    if (!item.identityKeyHash) return item;
    if (occurrences.get(item.identityKeyHash) > 1) {
      return review("ambiguous", item.identityKeyHash, item.sourceFingerprintHash, "duplicate_source_assignment_facts");
    }
    let existing;
    try { existing = await store.findByIdentityHash(item.identityKeyHash); }
    catch (_) { return review("needs_review", item.identityKeyHash, item.sourceFingerprintHash, "identity_store_unavailable"); }
    if (existing) {
      if (existing.state === "verified" && existing.sourceFingerprintHash === item.sourceFingerprintHash && UUID.test(existing.assignmentId || "")) {
        return resolved(existing.assignmentId, item.identityKeyHash, item.sourceFingerprintHash, existing.sheetMetadataId ?? null);
      }
      const changed = existing.sourceFingerprintHash !== item.sourceFingerprintHash;
      if (!changed && existing.state === "pending_review") {
        return review("pending_review", item.identityKeyHash, item.sourceFingerprintHash, "identity_confirmation_required");
      }
      return review("needs_review", item.identityKeyHash, item.sourceFingerprintHash,
        changed ? "source_fingerprint_changed" : `identity_${existing.state || "state_unknown"}`);
    }

    const assignmentId = createId();
    if (!UUID.test(assignmentId || "")) throw new TypeError("opaque_uuid_required");
    try {
      const inserted = await store.createPending({
        identityKeyHash: item.identityKeyHash,
        sourceFingerprintHash: item.sourceFingerprintHash,
        assignmentId
      });
      if (inserted?.conflict === true) {
        const raced = await store.findByIdentityHash(item.identityKeyHash);
        if (raced?.state === "verified" && raced.sourceFingerprintHash === item.sourceFingerprintHash && UUID.test(raced.assignmentId || "")) {
          return resolved(raced.assignmentId, item.identityKeyHash, item.sourceFingerprintHash, raced.sheetMetadataId ?? null);
        }
        return review("needs_review", item.identityKeyHash, item.sourceFingerprintHash, "concurrent_identity_review_required");
      }
      return review("pending_review", item.identityKeyHash, item.sourceFingerprintHash, "identity_confirmation_required");
    } catch (_) {
      return review("needs_review", item.identityKeyHash, item.sourceFingerprintHash, "identity_store_unavailable");
    }
  }));
}
