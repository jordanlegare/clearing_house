BEGIN;

CREATE TABLE IF NOT EXISTS recipient_funding_profiles (
  recipient_org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  mission text NOT NULL DEFAULT '',
  activities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(activities) = 'array'),
  populations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(populations) = 'array'),
  geography jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(geography) = 'array'),
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(outcomes) = 'array'),
  governance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(governance) = 'object'),
  financial_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(financial_summary) = 'object'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipient_funding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
  amount_cad numeric(18,2) NOT NULL CHECK (amount_cad > 0),
  objectives jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(objectives) = 'array'),
  activities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(activities) = 'array'),
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(outcomes) = 'array'),
  budget jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(budget) = 'array'),
  geography jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(geography) = 'array'),
  populations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(populations) = 'array'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  creation_idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_org_id,id)
);
CREATE INDEX IF NOT EXISTS recipient_funding_requests_org_idx
  ON recipient_funding_requests(recipient_org_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS grant_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  funding_request_id uuid NOT NULL,
  foundation_bn text NOT NULL CHECK (foundation_bn ~ '^[0-9]{9}RR[0-9]{4}$'),
  foundation_name text NOT NULL CHECK (length(btrim(foundation_name)) > 0),
  foundation_source_year integer,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','submitted','awarded','declined','withdrawn')),
  package_snapshot jsonb NOT NULL CHECK (jsonb_typeof(package_snapshot) = 'object'),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  readiness jsonb NOT NULL CHECK (jsonb_typeof(readiness) = 'object'),
  submission_channel text,
  external_submission_reference text,
  submitted_at timestamptz,
  outcome_rationale text,
  decided_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  creation_idempotency_key text NOT NULL UNIQUE,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recipient_org_id,funding_request_id)
    REFERENCES recipient_funding_requests(recipient_org_id,id) ON DELETE RESTRICT,
  CHECK (
    (status = 'draft' AND ready_at IS NULL AND submission_channel IS NULL
      AND external_submission_reference IS NULL AND submitted_at IS NULL
      AND outcome_rationale IS NULL AND decided_at IS NULL)
    OR (status = 'ready' AND ready_at IS NOT NULL AND ready_at >= created_at AND submission_channel IS NULL
      AND external_submission_reference IS NULL AND submitted_at IS NULL
      AND outcome_rationale IS NULL AND decided_at IS NULL)
    OR (status = 'submitted' AND ready_at IS NOT NULL AND ready_at >= created_at
      AND submission_channel IS NOT NULL AND length(btrim(submission_channel)) > 0
      AND external_submission_reference IS NOT NULL AND length(btrim(external_submission_reference)) > 0 AND submitted_at IS NOT NULL
      AND submitted_at >= ready_at
      AND outcome_rationale IS NULL AND decided_at IS NULL)
    OR (status IN ('awarded','declined') AND ready_at IS NOT NULL AND ready_at >= created_at
      AND submission_channel IS NOT NULL AND length(btrim(submission_channel)) > 0
      AND external_submission_reference IS NOT NULL AND length(btrim(external_submission_reference)) > 0
      AND submitted_at IS NOT NULL AND submitted_at >= ready_at
      AND outcome_rationale IS NOT NULL AND length(btrim(outcome_rationale)) > 0
      AND decided_at IS NOT NULL AND decided_at >= submitted_at)
    OR (status = 'withdrawn' AND outcome_rationale IS NOT NULL
      AND length(btrim(outcome_rationale)) > 0 AND decided_at IS NOT NULL AND (
        (ready_at IS NULL AND submission_channel IS NULL AND external_submission_reference IS NULL
          AND submitted_at IS NULL AND decided_at >= created_at)
        OR (ready_at IS NOT NULL AND ready_at >= created_at AND submission_channel IS NULL
          AND external_submission_reference IS NULL AND submitted_at IS NULL AND decided_at >= ready_at)
        OR (ready_at IS NOT NULL AND ready_at >= created_at
          AND submission_channel IS NOT NULL AND length(btrim(submission_channel)) > 0
          AND external_submission_reference IS NOT NULL AND length(btrim(external_submission_reference)) > 0
          AND submitted_at IS NOT NULL AND submitted_at >= ready_at AND decided_at >= submitted_at)
      ))
  )
);
CREATE INDEX IF NOT EXISTS grant_applications_recipient_idx
  ON grant_applications(recipient_org_id,status,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS grant_applications_one_active_target
  ON grant_applications(recipient_org_id,funding_request_id,foundation_bn)
  WHERE status IN ('draft','ready');

CREATE TABLE IF NOT EXISTS grant_application_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES grant_applications(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  from_status text NOT NULL CHECK (from_status IN ('draft','ready','submitted')),
  to_status text NOT NULL CHECK (to_status IN ('ready','submitted','awarded','declined','withdrawn')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (from_status = 'draft' AND to_status IN ('ready','withdrawn'))
    OR (from_status = 'ready' AND to_status IN ('submitted','withdrawn'))
    OR (from_status = 'submitted' AND to_status IN ('awarded','declined','withdrawn'))
  )
);
CREATE INDEX IF NOT EXISTS grant_application_events_application_idx
  ON grant_application_events(application_id,occurred_at,id);

-- Durable replay protection for profile, request and application mutations.
CREATE TABLE IF NOT EXISTS recipient_funding_operations (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  resource_id uuid,
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
