BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  business_number text,
  legal_name text NOT NULL,
  organization_type text NOT NULL CHECK (organization_type IN ('foundation','registered_charity','non_qualified_donee','other')),
  province text,
  public_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  private_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_bn_unique ON organizations(business_number) WHERE business_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('system_admin','foundation_analyst','foundation_approver','compliance_reviewer','recipient_admin','payment_operator','auditor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id, role)
);

CREATE TABLE IF NOT EXISTS recipient_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  claimed_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending','verified','rejected','revoked')),
  verification_method text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  foundation_org_id uuid NOT NULL REFERENCES organizations(id),
  recipient_org_id uuid NOT NULL REFERENCES organizations(id),
  amount_cad numeric(18,2) NOT NULL CHECK (amount_cad > 0),
  purpose text NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('qualified_donee','non_qualified_donee')),
  state text NOT NULL CHECK (state IN ('draft','proposed','approved','offered','accepted','payment_authorized','paid','reported','declined','cancelled')) DEFAULT 'draft',
  proposed_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  accepted_by uuid REFERENCES users(id),
  compliance_decision text CHECK (compliance_decision IN ('pending','approved','blocked','needs_review')) DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  from_state text,
  to_state text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipient_status_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source text NOT NULL,
  source_record_id text,
  status text NOT NULL CHECK (status IN ('eligible','ineligible','unknown','needs_review')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipient_status_latest_idx ON recipient_status_checks(organization_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS recipient_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES grants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  terms_version text NOT NULL,
  accepted boolean NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL UNIQUE REFERENCES grants(id),
  provider text NOT NULL CHECK (provider IN ('disabled','manual')),
  amount_cad numeric(18,2) NOT NULL CHECK (amount_cad > 0),
  status text NOT NULL CHECK (status IN ('created','authorized','external_execution_required','recorded','failed','cancelled')),
  external_reference text,
  authorized_by uuid REFERENCES users(id),
  authorized_at timestamptz,
  recorded_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid REFERENCES grants(id),
  channel text NOT NULL CHECK (channel IN ('email','sms','voice')),
  recipient text NOT NULL,
  template text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('queued','sent','failed','cancelled')) DEFAULT 'queued',
  idempotency_key text NOT NULL UNIQUE,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS reporting_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES grants(id),
  fiscal_year integer NOT NULL,
  reporting_route text NOT NULL,
  t3010_version text,
  t1441_required boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('draft','ready','exported','filed','amended')) DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  sequence bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_id text,
  ip_hash text,
  payload_digest text NOT NULL,
  previous_digest text,
  entry_hmac text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_resource_idx ON audit_log(resource_type, resource_id, sequence);

COMMIT;
