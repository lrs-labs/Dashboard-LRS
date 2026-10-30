import { sha256Hex, stableJson } from "../../../stable-json.mjs";
import { calculateAssignmentHashes } from "./assignment-identity.mjs";
import { computePeriodSourceRevision, contentAddressedPayrollEventRef } from "./payroll-source-projection.mjs";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-Q[12]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}
function snapshotBody(snapshot) {
  const { digest: _digest, ...body } = snapshot;
  return body;
}
function validateLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new TypeError("closed_snapshot_lines_required");
  const unique = new Set();
  for (const line of lines) {
    const key = `${line?.assignmentId}:${line?.role}`;
    if (!UUID.test(line?.assignmentId || "") || !["TP", "TA1", "TA2"].includes(line?.role) || unique.has(key) ||
        !line.technicianId || !Number.isFinite(line.amount) || line.amount < 0 ||
        !HASH.test(line.sourceFingerprintHash || "") || !["paid", "unpaid", "review", "zero"].includes(line.paymentState)) {
      throw new TypeError("closed_snapshot_assignment_invalid");
    }
    unique.add(key);
  }
}

export async function buildClosedPayrollSnapshot({ periodKey, sourceRevision, rows, core, closedAt, frozenAt = closedAt,
  snapshotId = globalThis.crypto?.randomUUID?.() } = {}) {
  if (!PERIOD.test(periodKey || "") || !HASH.test(sourceRevision || "") || !UUID.test(snapshotId || "") ||
      !timestamp(closedAt) || !timestamp(frozenAt) || Date.parse(frozenAt) < Date.parse(closedAt) || !core?.buildAssignments) {
    throw new TypeError("closed_snapshot_metadata_invalid");
  }
  const actualSourceRevision = await computePeriodSourceRevision(rows, periodKey, core);
  if (actualSourceRevision !== sourceRevision) throw new TypeError("closed_snapshot_source_revision_mismatch");
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const line of core.buildAssignments([row]).lines.filter(item => item.periodKey === periodKey)) {
      if (line.identityState !== "verified" || !Number.isFinite(line.amount) || !line.technicianId || !HASH.test(line.sourceFingerprintHash || "")) {
        throw new TypeError("closed_snapshot_assignment_review_required");
      }
      const eventRef = await contentAddressedPayrollEventRef(row, line);
      const hashes = await calculateAssignmentHashes({ eventRef, periodKey: line.periodKey, date: line.date, project: line.project,
        client: line.client, caseName: line.caseName, activity: line.activity, technicianId: line.technicianId,
        role: line.role, amount: line.amount, jobStatus: line.jobStatus, cancellationFee: line.cancellationFee });
      if (hashes.sourceFingerprintHash !== line.sourceFingerprintHash) throw new TypeError("closed_snapshot_assignment_fingerprint_mismatch");
      lines.push({
      assignmentId: line.assignmentId,
      sourceFingerprintHash: line.sourceFingerprintHash,
      ...(Number.isSafeInteger(line.sheetMetadataId) && line.sheetMetadataId > 0 ? { sheetMetadataId: line.sheetMetadataId } : {}),
      technicianId: line.technicianId,
      technician: line.technician,
      role: line.role,
      year: line.year,
      month: line.month,
      half: line.half,
      periodKey: line.periodKey,
      periodLabel: line.periodLabel,
      date: line.date,
      project: line.project,
      client: line.client,
      activity: line.activity,
      caseName: line.caseName,
      jobStatus: line.jobStatus,
      amount: line.amount,
      paidState: line.paidState,
      paymentState: line.paidState,
      paidFlag: line.paidState === "paid" ? true : line.paidState === "unpaid" ? false : null,
      reportPending: line.reportPending === true,
      cancellationFee: line.cancellationFee === true,
      eligible: true
      });
    }
  }
  if (!lines.length) throw new TypeError("closed_snapshot_period_empty");
  validateLines(lines);
  const body = { schema: 1, id: snapshotId, state: "closed", frozen: true, periodKey, sourceRevision, closedAt, frozenAt, lines };
  return { ...body, digest: await sha256Hex(stableJson(body)) };
}

export async function verifyClosedPayrollSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== 1 || snapshot.state !== "closed" || snapshot.frozen !== true ||
      !UUID.test(snapshot.id || "") || !PERIOD.test(snapshot.periodKey || "") || !HASH.test(snapshot.sourceRevision || "") ||
      !timestamp(snapshot.closedAt) || !timestamp(snapshot.frozenAt) || Date.parse(snapshot.frozenAt) < Date.parse(snapshot.closedAt) || !HASH.test(snapshot.digest || "")) {
    throw new TypeError("closed_snapshot_invalid");
  }
  validateLines(snapshot.lines);
  if (await sha256Hex(stableJson(snapshotBody(snapshot))) !== snapshot.digest) throw new TypeError("closed_snapshot_digest_mismatch");
  return snapshot;
}

/** Storage must provide atomic insert-if-period-empty (CAS); updates are not part of this contract. */
export function createImmutablePayrollSnapshotStore(storage) {
  if (typeof storage?.insertClosedIfAbsent !== "function" || typeof storage?.getClosed !== "function") {
    throw new TypeError("atomic_closed_snapshot_storage_required");
  }
  return Object.freeze({
    async close(snapshot) {
      await verifyClosedPayrollSnapshot(snapshot);
      const result = await storage.insertClosedIfAbsent({
        periodKey: snapshot.periodKey, snapshotId: snapshot.id, sourceRevision: snapshot.sourceRevision,
        digest: snapshot.digest, payload: snapshot
      });
      if (result?.state === "conflict") throw new Error("period_already_closed_review_required");
      if (!["inserted", "same"].includes(result?.state)) throw new Error("closed_snapshot_store_unavailable");
      const stored = await storage.getClosed({ periodKey: snapshot.periodKey, snapshotId: result.snapshotId || snapshot.id });
      await verifyClosedPayrollSnapshot(stored);
      if (stored.digest !== snapshot.digest || stored.sourceRevision !== snapshot.sourceRevision || (result.snapshotId && stored.id !== result.snapshotId)) throw new Error("closed_snapshot_cas_mismatch");
      return stored;
    },
    async getClosedSnapshot({ periodKey, snapshotId }) {
      if (!PERIOD.test(periodKey || "") || !UUID.test(snapshotId || "")) throw new TypeError("closed_snapshot_key_invalid");
      const snapshot = await storage.getClosed({ periodKey, snapshotId });
      if (!snapshot) throw new Error("closed_snapshot_not_found");
      await verifyClosedPayrollSnapshot(snapshot);
      if (snapshot.periodKey !== periodKey || snapshot.id !== snapshotId) throw new Error("closed_snapshot_identity_mismatch");
      return snapshot;
    },
    async listClosedSnapshots() {
      if (typeof storage.listClosed !== "function") throw new Error("closed_snapshot_list_unavailable");
      const records = await storage.listClosed();
      if (!Array.isArray(records)) throw new Error("closed_snapshot_list_invalid");
      const snapshots = [];
      for (const snapshot of records) snapshots.push(await verifyClosedPayrollSnapshot(snapshot));
      return snapshots;
    }
  });
}
