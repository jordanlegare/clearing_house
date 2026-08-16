BEGIN;

CREATE TABLE IF NOT EXISTS fiscal_reporting_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL UNIQUE REFERENCES fiscal_reporting_packages(id) ON DELETE RESTRICT,
  foundation_org_id uuid NOT NULL REFERENCES organizations(id),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  external_submission_reference text NOT NULL CHECK (length(btrim(external_submission_reference)) > 0),
  submitted_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE,
  grant_count integer NOT NULL CHECK (grant_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (foundation_org_id, external_submission_reference)
);
CREATE INDEX IF NOT EXISTS fiscal_reporting_submissions_foundation_idx
  ON fiscal_reporting_submissions(foundation_org_id,submitted_at DESC,created_at DESC);

COMMIT;
