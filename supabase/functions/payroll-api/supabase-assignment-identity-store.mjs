function unwrap(value) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function safeFailure() { return new Error("assignment_identity_store_unavailable"); }
function identityRecord(row) {
  if (!row || typeof row !== "object") return null;
  return {
    state: row.state,
    assignmentId: row.assignment_id,
    identityKeyHash: row.identity_key_sha256,
    sourceFingerprintHash: row.source_fingerprint_sha256,
    sheetMetadataId: Number.isSafeInteger(Number(row.sheet_metadata_id)) && Number(row.sheet_metadata_id) > 0 ? Number(row.sheet_metadata_id) : null
  };
}

export function createSupabaseAssignmentIdentityStore(supabaseAdmin) {
  if (typeof supabaseAdmin?.rpc !== "function") throw new TypeError("service_role_rpc_client_required");
  async function call(name, args) {
    let result;
    try { result = await supabaseAdmin.rpc(name, args); }
    catch (_) { throw safeFailure(); }
    if (result?.error) throw safeFailure();
    return result?.data;
  }
  return Object.freeze({
    async findByIdentityHash(identityKeyHash) {
      const value = unwrap(await call("lrs_assignment_identity_get", { p_identity_key_sha256: identityKeyHash }));
      const record = identityRecord(value);
      if (record && record.identityKeyHash !== identityKeyHash) throw safeFailure();
      return record;
    },
    async findByAssignmentIds(assignmentIds) {
      if (!Array.isArray(assignmentIds) || !assignmentIds.length || assignmentIds.length > 2000 ||
          assignmentIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || ""))) {
        throw new TypeError("assignment_identity_query_invalid");
      }
      const rows = await call("lrs_assignment_identity_find_many", { p_assignment_ids: [...new Set(assignmentIds)] });
      if (!Array.isArray(rows)) throw safeFailure();
      const records = rows.map(identityRecord);
      if (records.some(record => !record || !assignmentIds.includes(record.assignmentId))) throw safeFailure();
      return records;
    },
    async createPending({ identityKeyHash, assignmentId, sourceFingerprintHash }) {
      const inserted = await call("lrs_assignment_identity_insert_pending", {
        p_identity_key_sha256: identityKeyHash,
        p_assignment_id: assignmentId,
        p_source_fingerprint_sha256: sourceFingerprintHash
      });
      return inserted === true ? { inserted: true } : { conflict: true };
    },
    async verifyPending({ identityKeyHash, sourceFingerprintHash, actorId }) {
      const value = unwrap(await call("lrs_assignment_identity_verify", {
        p_identity_key_sha256: identityKeyHash,
        p_source_fingerprint_sha256: sourceFingerprintHash,
        p_actor_id: actorId
      }));
      return identityRecord(value);
    },
    async revoke({ identityKeyHash, actorId }) {
      const result = await call("lrs_assignment_identity_revoke", { p_identity_key_sha256: identityKeyHash, p_actor_id: actorId });
      return result === true;
    },
    async attachSheetMetadata({ identityKeyHash, sourceFingerprintHash, metadataId, actorId }) {
      const record = unwrap(await call("lrs_assignment_identity_attach_metadata", {
        p_identity_key_sha256: identityKeyHash,
        p_source_fingerprint_sha256: sourceFingerprintHash,
        p_metadata_id: metadataId,
        p_actor_id: actorId
      }));
      const result = identityRecord(record);
      if (result && result.sheetMetadataId !== Number(metadataId)) throw safeFailure();
      return result;
    }
  });
}
