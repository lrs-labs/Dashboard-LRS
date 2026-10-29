function unwrap(value) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function sanitizedError() { return new Error("private_workflow_store_unavailable"); }

export function createSupabaseWorkflowStore(supabaseAdmin) {
  if (typeof supabaseAdmin?.rpc !== "function") throw new TypeError("service_role_rpc_client_required");

  async function call(name, args) {
    let result;
    try { result = await supabaseAdmin.rpc(name, args); }
    catch (_) { throw sanitizedError(); }
    if (result?.error) throw sanitizedError();
    return result?.data;
  }

  const jobs = Object.freeze({
    async get(idempotencyKey) {
      const row = unwrap(await call("lrs_workflow_job_get", { p_idempotency_key: idempotencyKey }));
      if (!row || typeof row !== "object" || row.idempotency_key !== idempotencyKey) return null;
      return row;
    },
    async insertQueued(row) {
      const inserted = await call("lrs_workflow_job_insert", {
        p_idempotency_key: row.idempotency_key,
        p_job_type: row.job_type,
        p_period_key: row.period_key,
        p_technician_id: row.technician_id || null,
        p_source_snapshot_ref: row.source_snapshot_ref || null,
        p_request_digest: row.request_digest,
        p_requested_by: row.requested_by || null,
        p_lease_expires_at: row.lease_expires_at || null
      });
      return inserted === true;
    },
    async findUnresolvedEmail({ periodKey, technicianId }) {
      const rows = await call("lrs_workflow_job_find_unresolved_email", { p_period_key: periodKey, p_technician_id: technicianId });
      if (!Array.isArray(rows) || rows.some(row => !row || row.job_type !== "invoice_email" || row.period_key !== periodKey || row.technician_id !== technicianId)) {
        throw sanitizedError();
      }
      return rows;
    },
    async transition(idempotencyKey, nextState, patch = {}, options = {}) {
      const expectedState = options.expectedState;
      if (typeof expectedState !== "string") throw new TypeError("expected_workflow_state_required");
      const changed = await call("lrs_workflow_job_transition", {
        p_idempotency_key: idempotencyKey,
        p_expected_state: expectedState,
        p_next_state: nextState,
        p_patch: patch,
        p_reconciled: options.reconciled === true
      });
      if (changed !== true) throw new Error("workflow_transition_conflict");
      return true;
    }
  });

  const audit = Object.freeze({
    async record(event) {
      const recorded = await call("lrs_record_audit_event", {
        p_idempotency_key: event.idempotencyKey,
        p_actor_id: event.actorId || null,
        p_origin: event.origin,
        p_action: event.action,
        p_entity_type: event.entityType,
        p_entity_ref: event.entityRef,
        p_period_key: event.periodKey || null,
        p_source_snapshot_ref: event.sourceSnapshotRef || null,
        p_outcome: event.outcome
      });
      if (typeof recorded !== "boolean") throw sanitizedError();
      return recorded;
    }
  });

  return Object.freeze({ jobs, audit });
}
