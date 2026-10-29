function unwrap(value) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function sanitizedError() { return new Error("private_payroll_state_store_unavailable"); }

function makeRpc(supabaseAdmin) {
  if (typeof supabaseAdmin?.rpc !== "function") throw new TypeError("service_role_rpc_client_required");
  return async function call(name, args) {
    let result;
    try { result = await supabaseAdmin.rpc(name, args); } catch (_) { throw sanitizedError(); }
    if (result?.error) throw sanitizedError();
    return result?.data;
  };
}

function snapshotRecord(row) {
  if (!row || typeof row !== "object" || !row.payload || typeof row.payload !== "object") return null;
  if (row.period_key !== row.payload.periodKey || row.snapshot_id !== row.payload.id || row.digest !== row.payload.digest || row.source_revision !== row.payload.sourceRevision) return null;
  return row.payload;
}

export function createSupabasePayrollSnapshotStorage(supabaseAdmin) {
  const call = makeRpc(supabaseAdmin);
  return Object.freeze({
    async insertClosedIfAbsent({ periodKey, snapshotId, sourceRevision, digest, payload }) {
      const row = unwrap(await call("lrs_payroll_snapshot_close", {
        p_period_key: periodKey, p_snapshot_id: snapshotId, p_source_revision: sourceRevision,
        p_digest: digest, p_payload: payload
      }));
      if (!row || !["inserted", "same", "conflict"].includes(row.state) || typeof row.snapshot_id !== "string") throw sanitizedError();
      return { state: row.state, snapshotId: row.snapshot_id };
    },
    async getClosed({ periodKey, snapshotId }) {
      const row = unwrap(await call("lrs_payroll_snapshot_get", { p_period_key: periodKey, p_snapshot_id: snapshotId }));
      return snapshotRecord(row);
    },
    async listClosed() {
      const rows = await call("lrs_payroll_snapshot_list", {});
      if (!Array.isArray(rows)) throw sanitizedError();
      return rows.map(snapshotRecord);
    }
  });
}

function recipientRecord(row) {
  if (!row || typeof row !== "object") return null;
  return {
    technicianId: row.technician_id,
    directoryId: row.directory_id,
    displayName: row.display_name,
    email: row.email,
    active: row.active === true,
    verified: row.email_verified === true,
    verifiedAt: row.verified_at,
    directoryVersion: String(row.directory_version ?? "")
  };
}

/** Private recipient directory. Never expose this adapter to browser code. */
export function createSupabaseRecipientDirectory(supabaseAdmin) {
  const call = makeRpc(supabaseAdmin);
  return Object.freeze({
    async resolve(technicianId) {
      const row = unwrap(await call("lrs_recipient_directory_get", { p_technician_id: technicianId }));
      const record = recipientRecord(row);
      if (record && record.technicianId !== technicianId) throw sanitizedError();
      return record;
    },
    async listTechnicians() {
      const rows = await call("lrs_technician_directory_list", {});
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.technician_id !== "string" || typeof row.display_name !== "string")) throw sanitizedError();
      return rows.map(row => ({ technicianId: row.technician_id, displayName: row.display_name, active: row.active === true }));
    },
    async upsert({ technicianId, displayName, email, active, verified, actorId }) {
      if (!technicianId || !displayName || !email || !actorId || typeof active !== "boolean" || typeof verified !== "boolean") throw new TypeError("recipient_directory_input_invalid");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError("recipient_email_invalid");
      const row = unwrap(await call("lrs_recipient_directory_upsert", {
        p_technician_id: technicianId, p_display_name: displayName, p_email: email.toLowerCase(),
        p_active: active, p_email_verified: verified, p_actor_id: actorId
      }));
      const record = recipientRecord(row);
      if (!record || record.technicianId !== technicianId || !record.directoryId) throw sanitizedError();
      return record;
    }
  });
}
