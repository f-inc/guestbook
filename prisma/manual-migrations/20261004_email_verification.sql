CREATE TABLE IF NOT EXISTS email_verifications (
  "emailLower" TEXT PRIMARY KEY, "personId" TEXT, name TEXT,
  state TEXT NOT NULL DEFAULT 'unchecked', reason TEXT, score INTEGER,
  flags JSONB NOT NULL DEFAULT '{}', "checkedAt" TIMESTAMPTZ,
  "queuedRunId" TEXT
);
CREATE INDEX IF NOT EXISTS email_verifications_queue_idx ON email_verifications ("queuedRunId", "emailLower");
CREATE INDEX IF NOT EXISTS email_verifications_state_idx ON email_verifications (state, "emailLower");
CREATE TABLE IF NOT EXISTS email_verification_runs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "completedAt" TIMESTAMPTZ,
  "lockUntil" TIMESTAMPTZ, "nextCheckAt" TIMESTAMPTZ NOT NULL DEFAULT now(), error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS email_verification_one_active_run ON email_verification_runs ((true)) WHERE status IN ('running', 'paused', 'submission_unknown');
CREATE TABLE IF NOT EXISTS email_verification_batches (
  id TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "providerId" TEXT,
  status TEXT NOT NULL DEFAULT 'submitting', emails JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verification_batches_run_idx ON email_verification_batches ("runId", status);
