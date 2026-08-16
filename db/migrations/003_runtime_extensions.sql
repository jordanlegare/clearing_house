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

CREATE OR REPLACE FUNCTION enforce_nqd_diligence_before_compliance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recipient_type = 'non_qualified_donee'
     AND NEW.compliance_decision = 'approved'
     AND OLD.compliance_decision IS DISTINCT FROM NEW.compliance_decision THEN
    IF NOT EXISTS (
      SELECT 1 FROM grantee_diligence d
      WHERE d.grant_id = NEW.id
        AND d.status = 'approved'
        AND d.approved_by IS NOT NULL
        AND d.approved_by <> d.prepared_by
    ) THEN
      RAISE EXCEPTION 'approved non-qualified-donee diligence by a separate reviewer is required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS grants_nqd_diligence_gate ON grants;
CREATE TRIGGER grants_nqd_diligence_gate
BEFORE UPDATE OF compliance_decision ON grants
FOR EACH ROW EXECUTE FUNCTION enforce_nqd_diligence_before_compliance();

CREATE OR REPLACE FUNCTION enforce_payment_operator_separation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  effective_creator uuid;
BEGIN
  IF NEW.authorized_by IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.authorized_by IS DISTINCT FROM NEW.authorized_by) THEN
    effective_creator := NEW.created_by;

    -- The current repository authorizes with INSERT ... ON CONFLICT DO UPDATE.
    -- On the BEFORE INSERT phase, NEW is the proposed conflict row and therefore
    -- does not carry the existing intent's created_by. Consult the existing row
    -- so the creator/authorizer gate applies before conflict resolution as well.
    IF effective_creator IS NULL AND TG_OP = 'INSERT' THEN
      SELECT p.created_by INTO effective_creator
      FROM payment_intents p
      WHERE p.grant_id = NEW.grant_id;
    END IF;

    IF effective_creator IS NULL THEN
      RAISE EXCEPTION 'payment intent must be created by an operator before authorization';
    END IF;
    IF effective_creator = NEW.authorized_by THEN
      RAISE EXCEPTION 'payment intent creator cannot authorize the same payment';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM banking_verifications b
      WHERE b.grant_id = NEW.grant_id
        AND b.status = 'verified'
        AND (b.expires_at IS NULL OR b.expires_at > now())
      ORDER BY b.verified_at DESC
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'fresh verified external banking evidence is required before payment authorization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_intents_operator_gate ON payment_intents;
CREATE TRIGGER payment_intents_operator_gate
BEFORE INSERT OR UPDATE OF authorized_by ON payment_intents
FOR EACH ROW EXECUTE FUNCTION enforce_payment_operator_separation();

COMMIT;
