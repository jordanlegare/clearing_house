BEGIN;

CREATE TABLE IF NOT EXISTS user_global_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('system_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

ALTER TABLE recipient_claims
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS requested_role text NOT NULL DEFAULT 'recipient_admin'
    CHECK (requested_role IN ('foundation_analyst','foundation_approver','compliance_reviewer','recipient_admin','payment_operator','auditor'));
CREATE UNIQUE INDEX IF NOT EXISTS recipient_claims_idempotency_unique
  ON recipient_claims(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS creation_idempotency_key text,
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS terms_digest text,
  ADD COLUMN IF NOT EXISTS terms_text text,
  ADD COLUMN IF NOT EXISTS offered_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS grants_creation_idempotency_unique
  ON grants(creation_idempotency_key) WHERE creation_idempotency_key IS NOT NULL;

ALTER TABLE recipient_status_checks
  ADD COLUMN IF NOT EXISTS assurance_level text NOT NULL DEFAULT 'screening'
    CHECK (assurance_level IN ('screening','authoritative')),
  ADD COLUMN IF NOT EXISTS observed_status text,
  ADD COLUMN IF NOT EXISTS checked_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS recipient_status_idempotency_unique
  ON recipient_status_checks(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recipient_status_release_idx
  ON recipient_status_checks(organization_id, assurance_level, verified_at DESC);

CREATE TABLE IF NOT EXISTS compliance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approved','blocked','needs_review')),
  rationale text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compliance_reviews_grant_idx
  ON compliance_reviews(grant_id, created_at DESC);

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lock_token text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS notification_outbox_dispatch_idx
  ON notification_outbox(status, locked_at, created_at);

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_idempotency_unique
  ON payment_intents(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reporting_records_grant_fiscal_unique
  ON reporting_records(grant_id, fiscal_year);

COMMIT;
