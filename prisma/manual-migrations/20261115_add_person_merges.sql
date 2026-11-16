-- Additive migration only. Apply explicitly after reviewing target and backup.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE person_merge_members (
  person_id TEXT PRIMARY KEY REFERENCES luma_people(person_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  canonical_id TEXT NOT NULL REFERENCES luma_people(person_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX person_merge_members_canonical_id_idx ON person_merge_members(canonical_id);
CREATE TABLE person_merge_operations (
  id TEXT PRIMARY KEY,
  before JSONB NOT NULL,
  after JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at TIMESTAMPTZ
);
COMMIT;
