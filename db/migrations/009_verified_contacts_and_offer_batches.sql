BEGIN;

CREATE TABLE IF NOT EXISTS recipient_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms','voice')),
  destination_encrypted text NOT NULL,
  destination_fingerprint text NOT NULL,
  source text NOT NULL CHECK (source IN ('t3010_public','recipient_claim','external_verification','manual')),
  source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','verification_pending','verified','disabled')),
  verification_method text,
  verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel, destination_fingerprint)
);
CREATE INDEX IF NOT EXISTS recipient_contacts_org_status_idx ON recipient_contacts(organization_id,status,verified_at DESC);

CREATE TABLE IF NOT EXISTS recipient_contact_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES recipient_contacts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_secret_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recipient_contact_one_active_challenge
  ON recipient_contact_challenges(contact_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS grant_offer_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_bundle_id uuid NOT NULL UNIQUE REFERENCES grant_review_bundles(id) ON DELETE CASCADE,
  foundation_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  terms_digest text NOT NULL,
  terms_text text NOT NULL,
  preferred_channel text NOT NULL DEFAULT 'sms' CHECK (preferred_channel IN ('sms','voice')),
  status text NOT NULL DEFAULT 'pending_contacts' CHECK (status IN ('pending_contacts','ready','offering','offered','partial','cancelled')),
  batch_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS grant_offer_batches_status_idx ON grant_offer_batches(status,created_at);

CREATE TABLE IF NOT EXISTS grant_offer_batch_items (
  batch_id uuid NOT NULL REFERENCES grant_offer_batches(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  recipient_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES recipient_contacts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_contact' CHECK (status IN ('pending_contact','ready','offered','failed')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id,grant_id),
  UNIQUE (grant_id)
);
CREATE INDEX IF NOT EXISTS grant_offer_batch_items_status_idx ON grant_offer_batch_items(batch_id,status);

CREATE TABLE IF NOT EXISTS grant_offer_batch_commands (
  idempotency_key text PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES grant_offer_batches(id) ON DELETE CASCADE,
  command text NOT NULL CHECK (command IN ('create')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
