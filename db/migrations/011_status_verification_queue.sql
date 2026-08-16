BEGIN;

CREATE TABLE IF NOT EXISTS recipient_status_verification_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL UNIQUE REFERENCES grants(id) ON DELETE CASCADE,
  foundation_org_id uuid NOT NULL REFERENCES organizations(id),
  recipient_org_id uuid NOT NULL REFERENCES organizations(id),
  business_number text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','manual_confirmation_required','revocation_evidence_found','completed')),
  public_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_status_check_id uuid REFERENCES recipient_status_checks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipient_status_tasks_due_idx
  ON recipient_status_verification_tasks(status,next_check_at);
CREATE INDEX IF NOT EXISTS recipient_status_tasks_foundation_idx
  ON recipient_status_verification_tasks(foundation_org_id,status,updated_at DESC);

COMMIT;
