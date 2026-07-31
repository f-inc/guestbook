ALTER TABLE "luma_events"
  ADD COLUMN IF NOT EXISTS "feedback_average_rating" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "feedback_rating_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "feedback_stats_updated_at" TIMESTAMPTZ(6);
