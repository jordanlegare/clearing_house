BEGIN;

-- Secure no-account recipient offer access. The random bearer secret is stored only
-- as a SHA-256 lookup hash plus application-layer ciphertext so notification retries
-- can reuse the same link without storing the raw capability token in PostgreSQL.
ALTER TABLE offer_access_tokens
  ADD COLUMN IF NOT EXISTS token_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS terms_digest text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Earlier experimental branches could have produced more than one unused token for a
-- grant. Retire every older token before adding the one-active-capability invariant.
WITH ranked AS (
  SELECT id,
    row_number() OVER (PARTITION BY grant_id ORDER BY created_at DESC, id DESC) AS rn
  FROM offer_access_tokens
  WHERE used_at IS NULL AND revoked_at IS NULL
)
UPDATE offer_access_tokens t
SET revoked_at=now()
FROM ranked r
WHERE t.id=r.id AND r.rn > 1;

CREATE INDEX IF NOT EXISTS offer_access_active_grant_idx
  ON offer_access_tokens(grant_id, expires_at DESC)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS offer_access_one_active_per_grant
  ON offer_access_tokens(grant_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS recipient_consents_offer_token_idx
  ON recipient_consents(offer_token_id)
  WHERE offer_token_id IS NOT NULL;

COMMIT;
