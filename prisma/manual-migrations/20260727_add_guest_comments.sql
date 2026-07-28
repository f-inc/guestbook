CREATE TABLE IF NOT EXISTS guest_comments (
  id BIGSERIAL PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES luma_people(person_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'Guestbook',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP INDEX IF EXISTS guest_comments_person_id_created_at_idx;

CREATE INDEX IF NOT EXISTS guest_comments_person_id_created_at_id_idx
ON guest_comments (person_id, created_at DESC, id DESC);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS guest_comments_body_trgm_idx
ON guest_comments
USING GIN (LOWER(body) gin_trgm_ops);

DROP INDEX IF EXISTS luma_people_search_document_trgm_idx;

CREATE INDEX luma_people_search_document_trgm_idx
ON luma_people
USING GIN (
  LOWER(
    COALESCE(name, '') || ' ' ||
    COALESCE(email, '') || ' ' ||
    COALESCE(title, '') || ' ' ||
    COALESCE(bio, '')
  ) gin_trgm_ops
);

ALTER TABLE luma_people
  DROP COLUMN IF EXISTS crm_notes,
  DROP COLUMN IF EXISTS crm_notes_updated_at;
