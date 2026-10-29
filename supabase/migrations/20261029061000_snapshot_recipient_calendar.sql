-- Private control-plane support for immutable payroll close snapshots,
-- technician recipient/identity resolution and calendar-job recovery.
-- No source payroll rows are added to Supabase's public API.

CREATE TABLE IF NOT EXISTS private.payroll_closed_snapshots (
  period_key text PRIMARY KEY CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])-Q[12]$'),
  snapshot_id uuid NOT NULL UNIQUE,
  source_revision_sha256 text NOT NULL CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  closed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload ->> 'state' = 'closed' AND payload ->> 'frozen' = 'true'),
  CHECK (payload ->> 'id' IS NOT NULL AND payload ->> 'periodKey' IS NOT NULL)
);
ALTER TABLE private.payroll_closed_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.payroll_closed_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_closed_snapshots_deny_clients ON private.payroll_closed_snapshots
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON private.payroll_closed_snapshots FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON private.payroll_closed_snapshots FROM service_role;
GRANT SELECT, INSERT ON private.payroll_closed_snapshots TO service_role;

CREATE TABLE IF NOT EXISTS private.technician_recipients (
  directory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id text NOT NULL UNIQUE CHECK (length(btrim(technician_id)) BETWEEN 1 AND 160),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  email text NOT NULL CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  active boolean NOT NULL DEFAULT false,
  email_verified boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  directory_version bigint NOT NULL DEFAULT 1 CHECK (directory_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((email_verified = true) = (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS technician_recipients_one_active_email
  ON private.technician_recipients (lower(email)) WHERE active = true;
CREATE INDEX IF NOT EXISTS technician_recipients_name_lookup
  ON private.technician_recipients (lower(display_name)) WHERE active = true;
ALTER TABLE private.technician_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.technician_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_recipients_deny_clients ON private.technician_recipients
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON private.technician_recipients FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON private.technician_recipients FROM service_role;
GRANT SELECT ON private.technician_recipients TO service_role;
GRANT INSERT, UPDATE ON private.technician_recipients TO service_role;

-- Payroll identity roster is separate from the email directory; merely
-- learning a technician ID never requires storing or exposing an email.
CREATE TABLE IF NOT EXISTS private.payroll_technicians (
  technician_id text PRIMARY KEY CHECK (length(btrim(technician_id)) BETWEEN 1 AND 160),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  active boolean NOT NULL DEFAULT false,
  directory_version bigint NOT NULL DEFAULT 1 CHECK (directory_version > 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_technicians_name_lookup
  ON private.payroll_technicians (lower(display_name)) WHERE active = true;
ALTER TABLE private.payroll_technicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.payroll_technicians FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_technicians_deny_clients ON private.payroll_technicians
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON private.payroll_technicians FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON private.payroll_technicians FROM service_role;
GRANT SELECT, INSERT, UPDATE ON private.payroll_technicians TO service_role;

ALTER TABLE private.assignment_identities
  ADD COLUMN IF NOT EXISTS sheet_metadata_id bigint UNIQUE;

CREATE OR REPLACE FUNCTION public.lrs_assignment_identity_attach_metadata(
  p_identity_key_sha256 text,
  p_source_fingerprint_sha256 text,
  p_metadata_id bigint,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  result_row jsonb;
BEGIN
  IF p_identity_key_sha256 IS NULL OR p_identity_key_sha256 !~ '^[a-f0-9]{64}$'
     OR p_source_fingerprint_sha256 IS NULL OR p_source_fingerprint_sha256 !~ '^[a-f0-9]{64}$'
     OR p_metadata_id IS NULL OR p_metadata_id <= 0 OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'invalid_assignment_metadata';
  END IF;
  UPDATE private.assignment_identities AS a
  SET sheet_metadata_id = p_metadata_id, updated_at = now()
  WHERE a.identity_key_sha256 = p_identity_key_sha256
    AND a.source_fingerprint_sha256 = p_source_fingerprint_sha256
    AND a.state = 'verified'
    AND (a.sheet_metadata_id IS NULL OR a.sheet_metadata_id = p_metadata_id)
  RETURNING to_jsonb(a) INTO result_row;
  IF result_row IS NOT NULL THEN
    INSERT INTO private.audit_events (
      idempotency_key, actor_id, origin, action, entity_type, entity_ref, outcome
    ) VALUES (
      'lrs:assignment-metadata:' || p_identity_key_sha256 || ':' || p_metadata_id::text,
      p_actor_id, 'user', 'assignment_identity.attach_metadata', 'assignment_identity',
      p_identity_key_sha256, 'succeeded'
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN result_row;
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_assignment_identity_find_many(p_assignment_ids uuid[])
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT to_jsonb(a)
  FROM private.assignment_identities AS a
  WHERE p_assignment_ids IS NOT NULL AND cardinality(p_assignment_ids) BETWEEN 1 AND 2000
    AND a.assignment_id = ANY(p_assignment_ids)
  ORDER BY a.assignment_id
$$;

CREATE OR REPLACE FUNCTION public.lrs_payroll_snapshot_close(
  p_period_key text,
  p_snapshot_id uuid,
  p_source_revision text,
  p_digest text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_count integer;
  existing_row private.payroll_closed_snapshots%ROWTYPE;
BEGIN
  IF p_period_key IS NULL OR p_period_key !~ '^\d{4}-(0[1-9]|1[0-2])-Q[12]$'
     OR p_source_revision IS NULL OR p_source_revision !~ '^[a-f0-9]{64}$'
     OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_payload ->> 'schema' IS DISTINCT FROM '1'
     OR p_payload ->> 'state' IS DISTINCT FROM 'closed'
     OR p_payload ->> 'frozen' IS DISTINCT FROM 'true'
     OR p_payload ->> 'id' IS DISTINCT FROM p_snapshot_id::text
     OR p_payload ->> 'periodKey' IS DISTINCT FROM p_period_key
     OR p_payload ->> 'sourceRevision' IS DISTINCT FROM p_source_revision
     OR p_payload ->> 'digest' IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'invalid_closed_payroll_snapshot';
  END IF;
  IF jsonb_typeof(p_payload -> 'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_closed_payroll_snapshot';
  END IF;
  IF jsonb_array_length(p_payload -> 'lines') < 1 THEN
    RAISE EXCEPTION 'invalid_closed_payroll_snapshot';
  END IF;

  INSERT INTO private.payroll_closed_snapshots (
    period_key, snapshot_id, source_revision_sha256, snapshot_sha256, payload
  ) VALUES (p_period_key, p_snapshot_id, p_source_revision, p_digest, p_payload)
  ON CONFLICT (period_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 1 THEN
    RETURN jsonb_build_object('state', 'inserted', 'snapshot_id', p_snapshot_id::text);
  END IF;

  SELECT * INTO existing_row FROM private.payroll_closed_snapshots WHERE period_key = p_period_key;
  IF existing_row.snapshot_sha256 = p_digest AND existing_row.source_revision_sha256 = p_source_revision THEN
    RETURN jsonb_build_object('state', 'same', 'snapshot_id', existing_row.snapshot_id::text);
  END IF;
  RETURN jsonb_build_object('state', 'conflict', 'snapshot_id', existing_row.snapshot_id::text);
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_payroll_snapshot_get(p_period_key text, p_snapshot_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'period_key', s.period_key, 'snapshot_id', s.snapshot_id::text,
    'source_revision', s.source_revision_sha256, 'digest', s.snapshot_sha256,
    'payload', s.payload
  )
  FROM private.payroll_closed_snapshots AS s
  WHERE s.period_key = p_period_key AND s.snapshot_id = p_snapshot_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.lrs_payroll_snapshot_list()
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'period_key', s.period_key, 'snapshot_id', s.snapshot_id::text,
    'source_revision', s.source_revision_sha256, 'digest', s.snapshot_sha256,
    'payload', s.payload
  )
  FROM private.payroll_closed_snapshots AS s
  ORDER BY s.period_key DESC
  LIMIT 500
$$;

CREATE OR REPLACE FUNCTION public.lrs_recipient_directory_get(p_technician_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT to_jsonb(r) FROM private.technician_recipients AS r
  WHERE r.technician_id = p_technician_id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.lrs_technician_directory_list()
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object('technician_id', technician_id, 'display_name', display_name, 'active', active)
  FROM private.technician_recipients
  ORDER BY lower(display_name), technician_id
$$;

CREATE OR REPLACE FUNCTION public.lrs_payroll_technician_roster_list()
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object('technician_id', technician_id, 'display_name', display_name, 'active', active,
                            'directory_version', directory_version)
  FROM private.payroll_technicians
  WHERE active = true
  ORDER BY lower(display_name), technician_id
$$;

CREATE OR REPLACE FUNCTION public.lrs_payroll_technician_roster_upsert(
  p_technician_id text,
  p_display_name text,
  p_active boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE result_row jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_technician_id IS NULL OR length(btrim(p_technician_id)) NOT BETWEEN 1 AND 160
     OR p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 160 OR p_active IS NULL THEN
    RAISE EXCEPTION 'invalid_payroll_technician';
  END IF;
  INSERT INTO private.payroll_technicians AS current_technician (technician_id, display_name, active, updated_by)
  VALUES (btrim(p_technician_id), btrim(p_display_name), p_active, p_actor_id)
  ON CONFLICT (technician_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    active = EXCLUDED.active,
    directory_version = current_technician.directory_version + CASE WHEN
      (current_technician.display_name, current_technician.active) IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.active)
      THEN 1 ELSE 0 END,
    updated_by = EXCLUDED.updated_by,
    updated_at = now()
  RETURNING to_jsonb(current_technician) INTO result_row;
  INSERT INTO private.audit_events (idempotency_key, actor_id, origin, action, entity_type, entity_ref, outcome)
  VALUES ('lrs:payroll-roster:' || p_technician_id || ':' || pg_catalog.gen_random_uuid()::text,
          p_actor_id, 'user', 'payroll_technician.upsert', 'payroll_technician', p_technician_id, 'succeeded');
  RETURN result_row;
END
$$;

CREATE OR REPLACE FUNCTION public.lrs_recipient_directory_upsert(
  p_technician_id text,
  p_display_name text,
  p_email text,
  p_active boolean,
  p_email_verified boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  result_row jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_technician_id IS NULL OR length(btrim(p_technician_id)) NOT BETWEEN 1 AND 160
     OR p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 160
     OR p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_active IS NULL OR p_email_verified IS NULL THEN
    RAISE EXCEPTION 'invalid_recipient_directory_input';
  END IF;
  INSERT INTO private.technician_recipients AS current_recipient (
    technician_id, display_name, email, active, email_verified, verified_by, verified_at
  ) VALUES (
    p_technician_id, btrim(p_display_name), lower(btrim(p_email)), p_active, p_email_verified,
    CASE WHEN p_email_verified THEN p_actor_id ELSE NULL END,
    CASE WHEN p_email_verified THEN now() ELSE NULL END
  )
  ON CONFLICT (technician_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    email = EXCLUDED.email,
    active = EXCLUDED.active,
    email_verified = EXCLUDED.email_verified,
    verified_by = EXCLUDED.verified_by,
    verified_at = EXCLUDED.verified_at,
    directory_version = current_recipient.directory_version + CASE WHEN
      (current_recipient.display_name, current_recipient.email, current_recipient.active, current_recipient.email_verified,
       current_recipient.verified_by, current_recipient.verified_at)
        IS DISTINCT FROM
      (EXCLUDED.display_name, EXCLUDED.email, EXCLUDED.active, EXCLUDED.email_verified,
       EXCLUDED.verified_by, EXCLUDED.verified_at)
      THEN 1 ELSE 0 END,
    updated_at = now()
  RETURNING to_jsonb(current_recipient) INTO result_row;
  IF result_row IS NULL THEN
    SELECT to_jsonb(r) INTO result_row FROM private.technician_recipients AS r WHERE r.technician_id = p_technician_id;
  END IF;
  INSERT INTO private.audit_events (
    idempotency_key, actor_id, origin, action, entity_type, entity_ref, outcome
  ) VALUES (
    'lrs:recipient-directory:' || p_technician_id || ':' || pg_catalog.gen_random_uuid()::text,
    p_actor_id, 'user', 'recipient_directory.upsert', 'technician_recipient', p_technician_id, 'succeeded'
  );
  RETURN result_row;
END
$$;

REVOKE ALL ON FUNCTION public.lrs_payroll_snapshot_close(text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_payroll_snapshot_get(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_payroll_snapshot_list() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_assignment_identity_attach_metadata(text, text, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_assignment_identity_find_many(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_recipient_directory_get(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_technician_directory_list() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_payroll_technician_roster_list() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_payroll_technician_roster_upsert(text, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_recipient_directory_upsert(text, text, text, boolean, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lrs_payroll_snapshot_close(text, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_payroll_snapshot_get(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_payroll_snapshot_list() TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_assignment_identity_attach_metadata(text, text, bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_assignment_identity_find_many(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_recipient_directory_get(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_technician_directory_list() TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_payroll_technician_roster_list() TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_payroll_technician_roster_upsert(text, text, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_recipient_directory_upsert(text, text, text, boolean, boolean, uuid) TO service_role;

-- Only one application worker may own a technician-period invoice operation at a time.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_jobs_one_unresolved_drive_per_tech_period
  ON private.workflow_jobs (period_key, technician_id)
  WHERE job_type = 'invoice_drive' AND state IN ('queued', 'running', 'unknown', 'needs_review');

CREATE OR REPLACE FUNCTION public.lrs_workflow_job_claim_expired_queued(
  p_idempotency_key text,
  p_expected_lease_expires_at timestamptz,
  p_started_at timestamptz,
  p_lease_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed_count integer;
BEGIN
  IF p_idempotency_key IS NULL OR p_expected_lease_expires_at IS NULL OR p_started_at IS NULL
     OR p_lease_expires_at IS NULL OR p_lease_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_expired_job_claim';
  END IF;
  UPDATE private.workflow_jobs AS j
  SET state = 'running', started_at = p_started_at, lease_expires_at = p_lease_expires_at,
      attempt_count = j.attempt_count + 1, updated_at = now()
  WHERE j.idempotency_key = p_idempotency_key AND j.state = 'queued'
    AND j.lease_expires_at = p_expected_lease_expires_at AND j.lease_expires_at <= now();
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$$;

REVOKE ALL ON FUNCTION public.lrs_workflow_job_claim_expired_queued(text, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lrs_workflow_job_claim_expired_queued(text, timestamptz, timestamptz, timestamptz) TO service_role;
