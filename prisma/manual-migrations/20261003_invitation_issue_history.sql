ALTER TABLE luma_invite_tracking ADD COLUMN IF NOT EXISTS "issueMessages" JSONB NOT NULL DEFAULT '[]';
