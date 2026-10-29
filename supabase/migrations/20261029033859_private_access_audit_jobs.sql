-- Private control-plane records only. Payroll rows and payment truth remain
-- in Google Sheets; do not copy line items or recipient emails here.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE TABLE private.user_access (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ADMIN', 'FINANCE', 'VIEWER')),
  is_active boolean NOT NULL DEFAULT false,
  scope_mode text NOT NULL DEFAULT 'none' CHECK (scope_mode IN ('none', 'selected', 'all')),
  can_view_dashboard boolean NOT NULL DEFAULT false,
  can_view_payroll boolean NOT NULL DEFAULT false,
  can_generate_invoice boolean NOT NULL DEFAULT false,
  can_send_invoice boolean NOT NULL DEFAULT false,
  can_mark_paid boolean NOT NULL DEFAULT false,
  can_manage_users boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT can_generate_invoice OR can_view_payroll),
  CHECK (NOT can_send_invoice OR can_generate_invoice),
  CHECK (NOT can_mark_paid OR can_view_payroll),
  CHECK (NOT can_manage_users OR role = 'ADMIN'),
  CHECK (scope_mode <> 'none' OR (NOT can_view_dashboard AND NOT can_view_payroll)),
  CHECK (scope_mode <> 'selected' OR (can_view_dashboard OR can_view_payroll))
);

CREATE TABLE private.user_technician_scopes (
  user_id uuid NOT NULL REFERENCES private.user_access(user_id) ON DELETE CASCADE,
  technician_id text NOT NULL CHECK (length(btrim(technician_id)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, technician_id)
);

CREATE TABLE private.workflow_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 16 AND 240),
  job_type text NOT NULL CHECK (job_type IN ('period_close', 'invoice_drive', 'invoice_email', 'calendar_mark')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'unknown', 'needs_review')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  period_key text,
  technician_id text,
  source_snapshot_ref text,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 16 AND 240),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  origin text NOT NULL CHECK (origin IN ('user', 'automatic-calendar-policy', 'system')),
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 80),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) BETWEEN 1 AND 80),
  entity_ref text NOT NULL CHECK (length(btrim(entity_ref)) BETWEEN 1 AND 240),
  period_key text,
  source_snapshot_ref text,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'succeeded', 'failed', 'unknown', 'needs_review')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_jobs_state_created_idx ON private.workflow_jobs (state, created_at);
CREATE INDEX workflow_jobs_period_idx ON private.workflow_jobs (period_key, technician_id);
CREATE INDEX audit_events_entity_idx ON private.audit_events (entity_type, entity_ref, occurred_at DESC);

ALTER TABLE private.user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.user_access FORCE ROW LEVEL SECURITY;
ALTER TABLE private.user_technician_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.user_technician_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE private.workflow_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.workflow_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE private.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY user_access_deny_clients ON private.user_access
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY technician_scopes_deny_clients ON private.user_technician_scopes
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY workflow_jobs_deny_clients ON private.workflow_jobs
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY audit_events_deny_clients ON private.audit_events
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.user_access TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.user_technician_scopes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.workflow_jobs TO service_role;
GRANT SELECT, INSERT ON private.audit_events TO service_role;

-- The Edge Function calls these RPCs with a server-only service-role key.
-- Browser roles cannot invoke them and the private tables are not exposed.
CREATE OR REPLACE FUNCTION public.lrs_get_user_access(p_user_id uuid)
RETURNS TABLE (
  role text,
  is_active boolean,
  scope_mode text,
  can_view_dashboard boolean,
  can_view_payroll boolean,
  can_generate_invoice boolean,
  can_send_invoice boolean,
  can_mark_paid boolean,
  can_manage_users boolean,
  technician_ids text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.role, a.is_active, a.scope_mode, a.can_view_dashboard,
         a.can_view_payroll, a.can_generate_invoice, a.can_send_invoice,
         a.can_mark_paid, a.can_manage_users,
         COALESCE(array_agg(s.technician_id ORDER BY s.technician_id)
           FILTER (WHERE s.technician_id IS NOT NULL), ARRAY[]::text[])
  FROM private.user_access AS a
  LEFT JOIN private.user_technician_scopes AS s ON s.user_id = a.user_id
  WHERE a.user_id = p_user_id
  GROUP BY a.user_id
$$;

CREATE OR REPLACE FUNCTION public.lrs_record_audit_event(
  p_idempotency_key text,
  p_actor_id uuid,
  p_origin text,
  p_action text,
  p_entity_type text,
  p_entity_ref text,
  p_period_key text,
  p_source_snapshot_ref text,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_count integer;
BEGIN
  INSERT INTO private.audit_events (
    idempotency_key, actor_id, origin, action, entity_type, entity_ref,
    period_key, source_snapshot_ref, outcome
  ) VALUES (
    p_idempotency_key, p_actor_id, p_origin, p_action, p_entity_type, p_entity_ref,
    p_period_key, p_source_snapshot_ref, p_outcome
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END
$$;

REVOKE ALL ON FUNCTION public.lrs_get_user_access(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lrs_record_audit_event(text, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lrs_get_user_access(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lrs_record_audit_event(text, uuid, text, text, text, text, text, text, text) TO service_role;
