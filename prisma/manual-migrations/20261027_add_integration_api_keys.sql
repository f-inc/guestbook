-- Additive migration: creates an empty table; existing event/person data is untouched.
-- Apply only after verifying the target and taking an appropriate schema backup.
BEGIN;
CREATE TABLE integration_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  event_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(6),
  revoked_at TIMESTAMPTZ(6)
);
COMMIT;
-- Recovery: revoke all integration keys, roll back application code, then drop
-- this table only if its key metadata is no longer needed.
