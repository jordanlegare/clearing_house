BEGIN;

ALTER TABLE foundation_allocation_policies
  ADD COLUMN IF NOT EXISTS budget_basis text NOT NULL DEFAULT 'manual'
    CHECK (budget_basis IN ('manual','manual_override','dq_schedule8_current','dq_schedule8_next','dq_explicit_property','dq_flat_scenario')),
  ADD COLUMN IF NOT EXISTS budget_basis_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS budget_basis_hash text;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS planning_fiscal_year integer CHECK (planning_fiscal_year BETWEEN 2000 AND 2100);

CREATE INDEX IF NOT EXISTS grants_foundation_planning_year_idx
  ON grants(foundation_org_id, planning_fiscal_year, state);

COMMIT;
