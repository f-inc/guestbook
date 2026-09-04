ALTER TABLE "luma_event_sync_state"
  ADD COLUMN IF NOT EXISTS "last_webhook_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_webhook_id" TEXT;

CREATE TABLE IF NOT EXISTS "luma_webhook_deliveries" (
  "webhook_id" TEXT PRIMARY KEY,
  "webhook_type" TEXT NOT NULL,
  "event_id" TEXT,
  "guest_id" TEXT,
  "payload_sha256" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  "error" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "luma_webhook_deliveries_status_updated_at_idx"
  ON "luma_webhook_deliveries" ("status", "updated_at" ASC);

CREATE INDEX IF NOT EXISTS "luma_webhook_deliveries_event_id_received_at_idx"
  ON "luma_webhook_deliveries" ("event_id", "received_at" DESC);
