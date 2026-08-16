BEGIN;

CREATE TABLE IF NOT EXISTS foundation_allocation_policy_execution_options (
  policy_id uuid PRIMARY KEY REFERENCES foundation_allocation_policies(id) ON DELETE CASCADE,
  auto_propose_drafts boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS foundation_allocation_policy_option_commands (
  idempotency_key text PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES foundation_allocation_policies(id) ON DELETE CASCADE,
  auto_propose_drafts boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grant_review_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES foundation_allocation_policies(id) ON DELETE CASCADE,
  policy_run_id uuid REFERENCES foundation_allocation_policy_runs(id) ON DELETE SET NULL,
  foundation_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','approved','cancelled')),
  bundle_hash text NOT NULL,
  grant_count integer NOT NULL CHECK (grant_count > 0),
  total_cad numeric(18,2) NOT NULL CHECK (total_cad > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grant_review_bundles_policy_idx ON grant_review_bundles(policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS grant_review_bundles_foundation_status_idx ON grant_review_bundles(foundation_org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS grant_review_bundle_items (
  bundle_id uuid NOT NULL REFERENCES grant_review_bundles(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  recipient_org_id uuid NOT NULL REFERENCES organizations(id),
  amount_cad numeric(18,2) NOT NULL CHECK (amount_cad > 0),
  position integer NOT NULL CHECK (position > 0),
  PRIMARY KEY (bundle_id, grant_id),
  UNIQUE (grant_id),
  UNIQUE (bundle_id, position)
);
CREATE INDEX IF NOT EXISTS grant_review_bundle_items_bundle_idx ON grant_review_bundle_items(bundle_id, position);

CREATE TABLE IF NOT EXISTS grant_review_bundle_commands (
  idempotency_key text PRIMARY KEY,
  bundle_id uuid NOT NULL REFERENCES grant_review_bundles(id) ON DELETE CASCADE,
  command text NOT NULL CHECK (command IN ('approve')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
