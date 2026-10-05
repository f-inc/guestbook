BEGIN;
ALTER TABLE email_verifications RENAME TO email_addresses;
ALTER TABLE email_addresses ADD COLUMN "lumaBlockedReason" TEXT,
  ADD COLUMN "lumaBlockedAt" TIMESTAMPTZ,
  ADD COLUMN "lumaCheckedAt" TIMESTAMPTZ,
  ADD COLUMN "lumaClearedAt" TIMESTAMPTZ;
INSERT INTO email_addresses ("emailLower", "lumaBlockedReason", "lumaBlockedAt")
SELECT "emailLower", reason, "observedAt" FROM luma_email_suppressions
ON CONFLICT ("emailLower") DO UPDATE SET "lumaBlockedReason" = EXCLUDED."lumaBlockedReason", "lumaBlockedAt" = EXCLUDED."lumaBlockedAt";
CREATE TABLE email_verification_checks (
 id TEXT PRIMARY KEY, "emailLower" TEXT NOT NULL REFERENCES email_addresses("emailLower"),
 provider TEXT NOT NULL, "providerBatchId" TEXT, state TEXT NOT NULL, reason TEXT, score INTEGER,
 flags JSONB NOT NULL, "checkedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_checks_email_idx ON email_verification_checks ("emailLower", "checkedAt");
-- Preserve the latest existing result; earlier overwritten checks cannot be reconstructed.
INSERT INTO email_verification_checks (id,"emailLower",provider,state,reason,score,flags,"checkedAt")
SELECT 'migration:' || "emailLower", "emailLower", 'emailable', state, reason, score, flags, "checkedAt"
FROM email_addresses WHERE "checkedAt" IS NOT NULL;
ALTER TABLE email_verification_runs ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0, ADD COLUMN "eventIds" JSONB NOT NULL DEFAULT '[]';
DROP TABLE luma_email_suppressions;
COMMIT;
