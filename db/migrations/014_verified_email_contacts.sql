BEGIN;

ALTER TABLE recipient_contacts DROP CONSTRAINT IF EXISTS recipient_contacts_channel_check;
ALTER TABLE recipient_contacts ADD CONSTRAINT recipient_contacts_channel_check
  CHECK (channel IN ('sms','voice','email'));

ALTER TABLE grant_offer_batches DROP CONSTRAINT IF EXISTS grant_offer_batches_preferred_channel_check;
ALTER TABLE grant_offer_batches ADD CONSTRAINT grant_offer_batches_preferred_channel_check
  CHECK (preferred_channel IN ('sms','voice','email'));

CREATE TABLE IF NOT EXISTS recipient_contact_channel_discovery (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms','voice','email')),
  source text NOT NULL CHECK (source IN ('website_public')),
  status text NOT NULL DEFAULT 'no_candidates'
    CHECK (status IN ('succeeded','no_candidates','blocked','failed','no_website')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  pages_visited integer NOT NULL DEFAULT 0 CHECK (pages_visited >= 0),
  candidates_found integer NOT NULL DEFAULT 0 CHECK (candidates_found >= 0),
  inserted_contacts integer NOT NULL DEFAULT 0 CHECK (inserted_contacts >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, channel, source)
);
CREATE INDEX IF NOT EXISTS recipient_contact_channel_discovery_due_idx
  ON recipient_contact_channel_discovery(channel,source,next_attempt_at,status);

COMMIT;
