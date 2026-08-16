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

CREATE OR REPLACE FUNCTION set_grant_planning_year_from_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.automation_policy_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.automation_policy_id IS DISTINCT FROM NEW.automation_policy_id OR NEW.planning_fiscal_year IS NULL) THEN
    SELECT EXTRACT(YEAR FROM p.window_end)::integer INTO NEW.planning_fiscal_year
    FROM foundation_allocation_policies p
    WHERE p.id = NEW.automation_policy_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS grants_policy_planning_year ON grants;
CREATE TRIGGER grants_policy_planning_year
BEFORE INSERT OR UPDATE OF automation_policy_id, planning_fiscal_year ON grants
FOR EACH ROW EXECUTE FUNCTION set_grant_planning_year_from_policy();

COMMIT;
