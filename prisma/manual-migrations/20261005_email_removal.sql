-- Review and apply only with explicit authorization for the target database.
-- Additive: does not remove contacts or change existing data.
BEGIN;
CREATE TABLE email_removal_jobs (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'draft',
  calendars jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "confirmedAt" timestamptz,
  "completedAt" timestamptz
);
CREATE TABLE email_removal_items (
  "jobId" text NOT NULL REFERENCES email_removal_jobs(id),
  "emailLower" text NOT NULL,
  "calendarId" text NOT NULL,
  name text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  "attemptId" text,
  "startedAt" timestamptz,
  "completedAt" timestamptz,
  error text,
  PRIMARY KEY ("jobId", "emailLower", "calendarId")
);
CREATE INDEX email_removal_work ON email_removal_items (status, "jobId");
CREATE INDEX email_removal_email ON email_removal_items ("emailLower", status);
CREATE UNIQUE INDEX email_removal_one_running ON email_removal_jobs ((status)) WHERE status = 'running';
CREATE TABLE email_inactive (
  "emailLower" text PRIMARY KEY,
  "inactiveAt" timestamptz NOT NULL DEFAULT now(),
  "jobId" text NOT NULL REFERENCES email_removal_jobs(id)
);
CREATE VIEW guestbook_person_email_addresses AS
 SELECT person_id, lower(trim(coalesce(email_lower,email))) AS email FROM luma_people
 WHERE nullif(trim(coalesce(email_lower,email)), '') IS NOT NULL
 UNION SELECT person_id, lower(trim(coalesce(email_lower,email))) FROM luma_event_guests
 WHERE nullif(trim(coalesce(email_lower,email)), '') IS NOT NULL
 UNION SELECT "personId", lower(trim("emailLower")) FROM luma_invite_tracking WHERE "personId" IS NOT NULL
 UNION SELECT "personId", lower(trim("emailLower")) FROM email_addresses WHERE "personId" IS NOT NULL;
CREATE VIEW guestbook_inactive_people AS
 SELECT p.person_id FROM guestbook_person_email_addresses p
 LEFT JOIN email_inactive i ON i."emailLower" = p.email
 GROUP BY p.person_id HAVING count(*) FILTER (WHERE i."emailLower" IS NULL) = 0;
COMMIT;
-- Recovery: disable EMAIL_REMOVAL_ENABLED before reverting code/schema.
-- Keep these tables for audit/recovery; dropping them does not undo Luma removals.
