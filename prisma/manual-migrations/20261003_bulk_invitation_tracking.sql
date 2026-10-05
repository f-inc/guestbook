ALTER TABLE luma_invite_tracking ADD COLUMN IF NOT EXISTS "bulkInvite" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE luma_invite_tracking ADD COLUMN IF NOT EXISTS "bulkCheckedAt" TIMESTAMPTZ;
-- Retire automatic per-person polling, retaining observations and pending sends.
UPDATE luma_invite_tracking SET "nextCheckAt" = NULL, priority = 0 WHERE priority < 20;
-- Resume previously explicit event checks using Luma pagination, never the old person cursor.
INSERT INTO luma_tracking_state (key, active, "updatedAt")
SELECT 'bulk:' || substring(key from 10), true, now()
FROM luma_tracking_state WHERE key LIKE 'backfill:%' AND active = true
ON CONFLICT (key) DO NOTHING;
UPDATE luma_tracking_state SET active = false WHERE key LIKE 'backfill:%';
