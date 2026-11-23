-- Apply only after the target and its recovery snapshot have been approved.
-- Additive: preserves the existing delivery ledger and all application records.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE luma_webhook_deliveries
  ADD COLUMN IF NOT EXISTS payload JSONB,
  ADD COLUMN IF NOT EXISTS secret_name TEXT,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ(6);
CREATE INDEX IF NOT EXISTS luma_webhook_deliveries_pending_idx
  ON luma_webhook_deliveries (next_attempt_at, received_at)
  WHERE status IN ('queued', 'retry', 'processing') AND payload IS NOT NULL;
COMMIT;
