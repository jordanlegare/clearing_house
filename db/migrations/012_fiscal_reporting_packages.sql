BEGIN;

CREATE TABLE IF NOT EXISTS grant_reporting_metadata (
  grant_id uuid PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  non_cash_cad numeric(16,2) NOT NULL DEFAULT 0 CHECK (non_cash_cad >= 0),
  activities_outside_canada boolean,
  countries jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(countries)='array'),
  associated_charity boolean,
  designated_gift_cad numeric(16,2) NOT NULL DEFAULT 0 CHECK (designated_gift_cad >= 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grant_reporting_metadata_commands (
  idempotency_key text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fiscal_reporting_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  foundation_org_id uuid NOT NULL REFERENCES organizations(id),
  fiscal_period_start date NOT NULL,
  fiscal_period_end date NOT NULL CHECK (fiscal_period_end >= fiscal_period_start),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  filing_ready boolean NOT NULL DEFAULT false,
  prepared_by uuid NOT NULL REFERENCES users(id),
  preparation_idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (foundation_org_id,fiscal_period_start,fiscal_period_end,package_hash)
);
CREATE INDEX IF NOT EXISTS fiscal_reporting_packages_foundation_idx
  ON fiscal_reporting_packages(foundation_org_id,fiscal_period_end DESC,created_at DESC);

COMMIT;
