BEGIN;

CREATE TABLE IF NOT EXISTS foundation_allocation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  foundation_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  target_budget_cad numeric(18,2) NOT NULL CHECK (target_budget_cad > 0),
  focus text NOT NULL DEFAULT '',
  province text NOT NULL DEFAULT '',
  min_grant_cad numeric(18,2) NOT NULL DEFAULT 25000 CHECK (min_grant_cad > 0),
  max_grant_cad numeric(18,2) NOT NULL DEFAULT 250000 CHECK (max_grant_cad > 0),
  max_recipients integer NOT NULL DEFAULT 100 CHECK (max_recipients BETWEEN 1 AND 500),
  minimum_score numeric(12,8) NOT NULL DEFAULT 0 CHECK (minimum_score >= 0 AND minimum_score <= 1),
  purpose text NOT NULL DEFAULT 'General operating support',
  window_start date NOT NULL,
  window_end date NOT NULL,
  refresh_interval_seconds integer NOT NULL DEFAULT 3600 CHECK (refresh_interval_seconds BETWEEN 300 AND 604800),
  auto_materialize_drafts boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_run_status text CHECK (last_run_status IN ('success','skipped','failed','exhausted')),
  last_plan_hash text,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_grant_cad >= min_grant_cad),
  CHECK (window_end >= window_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_policy_title_unique
  ON foundation_allocation_policies(foundation_org_id, lower(title));
CREATE INDEX IF NOT EXISTS allocation_policy_due_idx
  ON foundation_allocation_policies(enabled, next_run_at, window_start, window_end);

ALTER TABLE grants ADD COLUMN IF NOT EXISTS automation_policy_id uuid REFERENCES foundation_allocation_policies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS grants_automation_policy_idx ON grants(automation_policy_id, state);

CREATE TABLE IF NOT EXISTS foundation_allocation_policy_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES foundation_allocation_policies(id) ON DELETE CASCADE,
  policy_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('running','success','skipped','failed','exhausted')) DEFAULT 'running',
  remaining_budget_before_cad numeric(18,2),
  planned_cad numeric(18,2),
  draft_count integer NOT NULL DEFAULT 0,
  plan_hash text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS allocation_policy_runs_policy_idx
  ON foundation_allocation_policy_runs(policy_id, started_at DESC);

COMMIT;
