ALTER TABLE luma_events
  ADD COLUMN IF NOT EXISTS overview_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS overview_stats_updated_at TIMESTAMPTZ;

ALTER TABLE luma_event_guests
  ADD COLUMN IF NOT EXISTS is_referred BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_new_referral BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_prior_event BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metrics_derived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS luma_event_guests_event_id_has_prior_event_idx
  ON luma_event_guests (event_id, has_prior_event);

CREATE INDEX IF NOT EXISTS luma_event_guests_event_id_is_referred_is_new_referral_idx
  ON luma_event_guests (event_id, is_referred, is_new_referral);
