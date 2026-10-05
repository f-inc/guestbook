ALTER TABLE luma_invite_tracking ADD COLUMN IF NOT EXISTS "nextCheckAt" timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "retryCount" integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS "lastError" text;
CREATE INDEX IF NOT EXISTS luma_invite_tracking_due ON luma_invite_tracking ("nextCheckAt", priority);
CREATE TABLE IF NOT EXISTS luma_tracking_state (key text PRIMARY KEY, "leaseUntil" timestamptz, owner text, cursor text, active boolean NOT NULL DEFAULT false, "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS luma_calendar_opt_outs ("calendarId" text NOT NULL, "emailLower" text NOT NULL, "observedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("calendarId", "emailLower"));
