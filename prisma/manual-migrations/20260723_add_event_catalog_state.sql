ALTER TABLE "luma_events"
ADD COLUMN IF NOT EXISTS "catalog_active" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS "luma_events_catalog_active_starts_at_idx"
ON "luma_events" ("catalog_active", "starts_at" DESC);
