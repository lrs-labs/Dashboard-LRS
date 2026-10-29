-- Runtime state for idempotent jobs and stable project/slot identities.
-- This migration adds control-plane metadata only: no payroll lines, amounts,
-- client names, event references, or technician email addresses are copied.

ALTER TABLE private.workflow_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS result_payload jsonb;

CREATE TABLE IF NOT EXISTS private.assignment_identities (
  identity_key_sha256 text PRIMARY KEY CHECK (identity_key_sha256 ~ '^[a-f0-9]{64}$'),
  assignment_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  source_fingerprint_sha256 text NOT NULL CHECK (source_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review', 'verified', 'revoked')),
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'verified') = (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS assignment_identities_state_created_idx
  ON private.assignment_identities (state, created_at);

ALTER TABLE private.assignment_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.assignment_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_identities_deny_clients ON private.assignment_identities
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON private.assignment_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON private.assignment_identities TO service_role;

COMMENT ON TABLE private.assignment_identities IS
  'Opaque assignment-ID sidecar. Only hashes and approved UUIDs are stored; unresolved or changed facts require review.';
