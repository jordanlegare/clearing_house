BEGIN;

ALTER TABLE recipient_contacts DROP CONSTRAINT IF EXISTS recipient_contacts_source_check;
ALTER TABLE recipient_contacts ADD CONSTRAINT recipient_contacts_source_check
  CHECK (source IN ('t3010_public','website_public','recipient_claim','external_verification','manual'));

CREATE TABLE IF NOT EXISTS recipient_contact_discovery (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  website_url text,
  status text NOT NULL DEFAULT 'no_website'
    CHECK (status IN ('succeeded','no_candidates','blocked','failed','no_website')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  pages_visited integer NOT NULL DEFAULT 0 CHECK (pages_visited >= 0),
  candidates_found integer NOT NULL DEFAULT 0 CHECK (candidates_found >= 0),
  inserted_contacts integer NOT NULL DEFAULT 0 CHECK (inserted_contacts >= 0),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipient_contact_discovery_due_idx
  ON recipient_contact_discovery(next_attempt_at,status);

COMMIT;
