BEGIN;

-- Reconciled from PR #3 onto the authenticated workflow runtime merged in PR #4.
-- This migration adds the schema needed for allocation-plan metadata, proportional
-- non-qualified-donee diligence, one-time browser offer links, second-operator
-- payment workflows, and external banking-verification references.

CREATE TABLE IF NOT EXISTS allocation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  foundation_org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL,
  focus text NOT NULL DEFAULT '',
  total_budget_cad numeric(18,2) NOT NULL CHECK (total_budget_cad > 0),
  state text NOT NULL CHECK (state IN ('draft','proposed','approved','offered','partial_offered','closed','cancelled')) DEFAULT 'draft',
  created_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE grants ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES allocation_plans(id) ON DELETE SET NULL;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS rationale text NOT NULL DEFAULT '';
ALTER TABLE grants ADD COLUMN IF NOT EXISTS restriction_type text NOT NULL DEFAULT 'unrestricted';
CREATE INDEX IF NOT EXISTS grants_plan_idx ON grants(plan_id);

CREATE TABLE IF NOT EXISTS grantee_diligence (
  grant_id uuid PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  assessment jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_risk text NOT NULL CHECK (recommended_risk IN ('low','medium','high')) DEFAULT 'medium',
  status text NOT NULL CHECK (status IN ('draft','approved','rejected')) DEFAULT 'draft',
  prepared_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);

CREATE TABLE IF NOT EXISTS offer_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offer_access_grant_idx ON offer_access_tokens(grant_id, created_at DESC);

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE recipient_consents ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE recipient_consents ADD COLUMN IF NOT EXISTS acceptance_method text NOT NULL DEFAULT 'authenticated_user';
ALTER TABLE recipient_consents ADD COLUMN IF NOT EXISTS offer_token_id uuid REFERENCES offer_access_tokens(id);

ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS last_error text;

CREATE TABLE IF NOT EXISTS banking_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('verified','needs_review','failed','expired')),
  external_reference_encrypted text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_by uuid NOT NULL REFERENCES users(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS banking_verifications_grant_idx ON banking_verifications(grant_id, verified_at DESC);

COMMIT;
