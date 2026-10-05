CREATE TABLE IF NOT EXISTS "luma_invite_tracking" (
  "eventId" TEXT NOT NULL,
  "emailLower" TEXT NOT NULL,
  "personId" TEXT,
  "lumaUserId" TEXT,
  "name" TEXT,
  "eventTitle" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "messages" JSONB NOT NULL DEFAULT '[]',
  "checkedAt" TIMESTAMPTZ(6),
  "requestedAt" TIMESTAMPTZ(6),
  "issueReason" TEXT,
  "removedAt" TIMESTAMPTZ(6),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("eventId", "emailLower")
);
CREATE INDEX IF NOT EXISTS "luma_invite_tracking_status_checkedAt_idx" ON "luma_invite_tracking"("status", "checkedAt");
CREATE INDEX IF NOT EXISTS "luma_invite_tracking_emailLower_idx" ON "luma_invite_tracking"("emailLower");
CREATE TABLE IF NOT EXISTS "luma_invite_attempts" (
  "id" TEXT PRIMARY KEY,
  "batchId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "emailLower" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "luma_invite_attempts_eventId_createdAt_idx" ON "luma_invite_attempts"("eventId", "createdAt");
CREATE INDEX IF NOT EXISTS "luma_invite_attempts_batchId_idx" ON "luma_invite_attempts"("batchId");
CREATE TABLE IF NOT EXISTS "luma_email_suppressions" (
  "emailLower" TEXT PRIMARY KEY,
  "reason" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
