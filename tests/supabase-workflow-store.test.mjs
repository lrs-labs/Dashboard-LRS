import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSupabaseWorkflowStore } from "../supabase/functions/payroll-api/supabase-workflow-store.mjs";

test("workflow store persists jobs and audit only through fixed private RPC contracts", async () => {
  const calls = [];
  const job = { idempotency_key: "job-fixture-key-123", job_type: "invoice_drive", period_key: "2026-10-Q1", state: "queued" };
  const client = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === "lrs_workflow_job_get") return { data: job, error: null };
    if (name === "lrs_workflow_job_insert") return { data: true, error: null };
    if (name === "lrs_workflow_job_find_unresolved_email") return { data: [], error: null };
    if (name === "lrs_workflow_job_transition" || name === "lrs_record_audit_event") return { data: true, error: null };
    throw new Error("unexpected_rpc");
  } };
  const store = createSupabaseWorkflowStore(client);
  assert.deepEqual(await store.jobs.get(job.idempotency_key), job);
  assert.equal(await store.jobs.insertQueued({ idempotency_key: job.idempotency_key, job_type: "invoice_drive", period_key: job.period_key,
    technician_id: "tech-fixture", source_snapshot_ref: "snapshot-fixture", request_digest: "a".repeat(64), requested_by: "user-fixture", lease_expires_at: "2026-10-29T12:00:00Z" }), true);
  assert.deepEqual(await store.jobs.findUnresolvedEmail({ periodKey: "2026-10-Q1", technicianId: "tech-fixture" }), []);
  await store.jobs.transition(job.idempotency_key, "running", { started_at: "2026-10-29T12:00:00Z" }, { expectedState: "queued" });
  await store.audit.record({ idempotencyKey: job.idempotency_key, actorId: "user-fixture", origin: "user", action: "invoice_drive",
    entityType: "invoice_drive", entityRef: "snapshot-fixture:tech-fixture", periodKey: job.period_key, outcome: "succeeded" });
  assert.deepEqual(calls.map(call => call.name), ["lrs_workflow_job_get", "lrs_workflow_job_insert", "lrs_workflow_job_find_unresolved_email", "lrs_workflow_job_transition", "lrs_record_audit_event"]);
  assert.equal(calls[3].args.p_expected_state, "queued");
  assert.equal(calls[3].args.p_next_state, "running");
});

test("workflow store fails closed on RPC error or invalid transition and exposes no provider error body", async () => {
  const errorClient = createSupabaseWorkflowStore({ async rpc() { return { data: null, error: { message: "private provider response" } }; } });
  await assert.rejects(errorClient.jobs.get("fixture-job"), error => {
    assert.equal(error.message, "private_workflow_store_unavailable");
    assert.equal(error.message.includes("private provider response"), false);
    return true;
  });
  const conflictClient = createSupabaseWorkflowStore({ async rpc() { return { data: false, error: null }; } });
  await assert.rejects(conflictClient.jobs.transition("fixture-job", "running", {}, { expectedState: "queued" }), /workflow_transition_conflict/);
});

test("workflow store migration limits job operations to server role and atomically holds uncertain email attempts", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261029052000_workflow_store_rpc.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS workflow_jobs_one_unresolved_email_per_tech_period/);
  assert.match(sql, /state IN \('queued', 'running', 'unknown', 'needs_review'\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.lrs_workflow_job_insert[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.lrs_workflow_job_transition[\s\S]+TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.lrs_assignment_identity_verify[\s\S]+TO service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.lrs_assignment_identity_get\(text\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /j\.state = p_expected_state/);
  assert.equal((sql.match(/'lrs:assignment-(?:verify|revoke):' \|\| p_identity_key_sha256 \|\| ':' \|\| pg_catalog\.gen_random_uuid\(\)::text/g) || []).length, 2);
  assert.equal((sql.match(/^SECURITY INVOKER$/gm) || []).length, 8);
  assert.doesNotMatch(sql, /^\s*SECURITY DEFINER$/m);
  assert.match(sql, /ALTER FUNCTION public\.lrs_get_user_access\(uuid\) SECURITY INVOKER/);
  assert.match(sql, /ALTER FUNCTION public\.lrs_record_audit_event\(text, uuid, text, text, text, text, text, text, text\) SECURITY INVOKER/);
});
