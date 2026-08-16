BEGIN;

CREATE TABLE IF NOT EXISTS automation_jobs (
  name text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  interval_seconds integer NOT NULL CHECK (interval_seconds > 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text CHECK (last_status IN ('running','success','failed','skipped')),
  last_error text,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_jobs_due_idx
  ON automation_jobs(enabled, next_run_at, locked_until);

CREATE TABLE IF NOT EXISTS automation_worker_heartbeats (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'starting',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
