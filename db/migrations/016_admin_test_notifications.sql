ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS created_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'notification_outbox'::regclass
      AND conname = 'notification_outbox_created_by_fkey'
  ) THEN
    ALTER TABLE notification_outbox
      ADD CONSTRAINT notification_outbox_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) NOT VALID;
  END IF;
END
$$;

ALTER TABLE notification_outbox
  VALIDATE CONSTRAINT notification_outbox_created_by_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.notification_outbox_admin_test_rate_idx')
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.notification_outbox_admin_test_rate_idx';
  END IF;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS notification_outbox_admin_test_rate_idx
  ON notification_outbox(created_by, created_at DESC)
  WHERE template = 'admin_test';
