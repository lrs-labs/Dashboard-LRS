-- Atomic server-only operations for idempotent invoice jobs. The unique
-- partial index allows a new explicit resend after a completed/failed job,
-- but holds one technician/period while any prior send is unresolved.
ALTER TABLE private.workflow_jobs
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

-- These earlier service-only RPCs do not need SECURITY DEFINER: the Edge
-- Function uses the service role, which already has the required table grants.
ALTER FUNCTION public.lrs_get_user_access(uuid) SECURITY INVOKER;
ALTER FUNCTION public.lrs_record_audit_event(text, uuid, text, text, text, text, text, text, text) SECURITY INVOKER;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_jobs_one_unresolved_email_per_tech_period
  ON private.workflow_jobs (period_key, technician_id)
  WHERE job_type = 'invoice_email' AND state IN ('queued', 'running', 'unknown', 'needs_review');

CREATE OR REPLACE FUNCTION public.lrs_workflow_job_get(p_idempotency_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT to_jsonb(j)
  FROM private.workflow_jobs AS j
  WHERE j.idempotency_key = p_idempotency_key
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.lrs_workflow_job_insert(
  p_idempotency_key text,
  p_job_type text,
  p_period_key text,
  p_technician_id text,
  p_source_snapshot_ref text,
  p_request_digest text,
  p_requested_by uuid,
  p_lease_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_count integer;
BEGIN
  IF p_job_type NOT IN ('invoice_drive', 'invoice_email', 'calendar_mark', 'period_close')
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 16 AND 240
     OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_workflow_job';
  END IF;
  INSERT INTO private.workflow_jobs (
    idempotency_key, job_type, period_key, technician_id, source_snapshot_ref,
    request_digest, requested_by, lease_expires_at
  ) VALUES (
    p_idempotency_key, p_job_type, p_period_key, p_technician_id, p_source_snapshot_ref,
    p_request_digest, p_requested_by, p_lease_expires_at
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_workflow_job_find_unresolved_email(
  p_period_key text,
  p_technician_id text
)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT to_jsonb(j)
  FROM private.workflow_jobs AS j
  WHERE j.job_type = 'invoice_email'
    AND j.period_key = p_period_key
    AND j.technician_id = p_technician_id
    AND j.state IN ('queued', 'running', 'unknown', 'needs_review')
  ORDER BY j.created_at
$$;

CREATE OR REPLACE FUNCTION public.lrs_workflow_job_transition(
  p_idempotency_key text,
  p_expected_state text,
  p_next_state text,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_reconciled boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_count integer;
BEGIN
  IF jsonb_typeof(p_patch) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_patch) AS k(key)
       WHERE k.key NOT IN ('result_code', 'result_payload', 'started_at', 'completed_at', 'lease_expires_at', 'reconciled_at')
     ) THEN
    RAISE EXCEPTION 'invalid_workflow_patch';
  END IF;
  IF NOT (
    (p_expected_state = 'queued' AND p_next_state IN ('running', 'failed', 'needs_review')) OR
    (p_expected_state = 'running' AND p_next_state IN ('succeeded', 'failed', 'unknown', 'needs_review')) OR
    (p_reconciled AND p_expected_state IN ('unknown', 'needs_review') AND p_next_state IN ('succeeded', 'failed', 'needs_review')) OR
    (p_reconciled AND p_expected_state = 'needs_review' AND p_next_state = 'running')
  ) THEN
    RAISE EXCEPTION 'invalid_workflow_transition';
  END IF;
  UPDATE private.workflow_jobs AS j
  SET state = p_next_state,
      result_code = CASE WHEN p_patch ? 'result_code' THEN p_patch ->> 'result_code' ELSE j.result_code END,
      result_payload = CASE WHEN p_patch ? 'result_payload' THEN p_patch -> 'result_payload' ELSE j.result_payload END,
      started_at = CASE WHEN p_patch ? 'started_at' THEN (p_patch ->> 'started_at')::timestamptz ELSE j.started_at END,
      completed_at = CASE WHEN p_patch ? 'completed_at' THEN (p_patch ->> 'completed_at')::timestamptz ELSE j.completed_at END,
      lease_expires_at = CASE WHEN p_patch ? 'lease_expires_at' THEN (p_patch ->> 'lease_expires_at')::timestamptz ELSE j.lease_expires_at END,
      reconciled_at = CASE WHEN p_patch ? 'reconciled_at' THEN (p_patch ->> 'reconciled_at')::timestamptz ELSE j.reconciled_at END,
      attempt_count = j.attempt_count + CASE WHEN p_next_state = 'running' THEN 1 ELSE 0 END,
      updated_at = now()
  WHERE j.idempotency_key = p_idempotency_key AND j.state = p_expected_state;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_assignment_identity_get(p_identity_key_sha256 text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT to_jsonb(a)
  FROM private.assignment_identities AS a
  WHERE a.identity_key_sha256 = p_identity_key_sha256
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.lrs_assignment_identity_insert_pending(
  p_identity_key_sha256 text,
  p_assignment_id uuid,
  p_source_fingerprint_sha256 text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_count integer;
BEGIN
  IF p_identity_key_sha256 !~ '^[a-f0-9]{64}$'
     OR p_source_fingerprint_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_assignment_identity';
  END IF;
  INSERT INTO private.assignment_identities (
    identity_key_sha256, assignment_id, source_fingerprint_sha256, state
  ) VALUES (
    p_identity_key_sha256, p_assignment_id, p_source_fingerprint_sha256, 'pending_review'
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_assignment_identity_verify(
  p_identity_key_sha256 text,
  p_source_fingerprint_sha256 text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  verified_row jsonb;
  verified_at_value timestamptz;
BEGIN
  IF p_identity_key_sha256 !~ '^[a-f0-9]{64}$'
     OR p_source_fingerprint_sha256 !~ '^[a-f0-9]{64}$' OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'invalid_assignment_identity_review';
  END IF;
  UPDATE private.assignment_identities AS a
  SET state = 'verified', verified_by = p_actor_id, verified_at = now(), updated_at = now()
  WHERE a.identity_key_sha256 = p_identity_key_sha256
    AND a.source_fingerprint_sha256 = p_source_fingerprint_sha256
    AND a.state = 'pending_review'
  RETURNING to_jsonb(a) INTO verified_row;
  IF verified_row IS NOT NULL THEN
    verified_at_value := (verified_row ->> 'verified_at')::timestamptz;
    INSERT INTO private.audit_events (
      idempotency_key, actor_id, origin, action, entity_type, entity_ref, outcome, occurred_at
    ) VALUES (
      'lrs:assignment-verify:' || p_identity_key_sha256 || ':' || pg_catalog.gen_random_uuid()::text,
      p_actor_id, 'user', 'assignment_identity.verify', 'assignment_identity',
      p_identity_key_sha256, 'succeeded', verified_at_value
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN verified_row;
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_assignment_identity_revoke(p_identity_key_sha256 text, p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_count integer;
BEGIN
  IF p_identity_key_sha256 !~ '^[a-f0-9]{64}$' OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'invalid_assignment_identity_review';
  END IF;
  UPDATE private.assignment_identities AS a
  SET state = 'revoked', verified_by = NULL, verified_at = NULL, updated_at = now()
  WHERE a.identity_key_sha256 = p_identity_key_sha256 AND a.state <> 'revoked';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count = 1 THEN
    INSERT INTO private.audit_events (
      idempotency_key, actor_id, origin, action, entity_type, entity_ref, outcome
    ) VALUES (
      'lrs:assignment-revoke:' || p_identity_key_sha256 || ':' || pg_catalog.gen_random_uuid()::text,
      p_actor_id, 'user', 'assignment_identity.revoke', 'assignment_identity',
      p_identity_key_sha256, 'succeeded'
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN changed_count = 1;
END
$$;

REVOKE ALL ON FUNCTION public.lrs_workflow_job_get(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_workflow_job_insert(text, text, text, text, text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_workflow_job_find_unresolved_email(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_workflow_job_transition(text, text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_assignment_identity_get(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_assignment_identity_insert_pending(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_assignment_identity_verify(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_assignment_identity_revoke(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lrs_workflow_job_get(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_workflow_job_insert(text, text, text, text, text, text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_workflow_job_find_unresolved_email(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_workflow_job_transition(text, text, text, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_assignment_identity_get(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_assignment_identity_insert_pending(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_assignment_identity_verify(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_assignment_identity_revoke(text, uuid) TO service_role;
