CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS luma_people_search_document_trgm_idx
ON luma_people
USING GIN (
  LOWER(
    COALESCE(name, '') || ' ' ||
    COALESCE(email, '') || ' ' ||
    COALESCE(title, '') || ' ' ||
    COALESCE(bio, '') || ' ' ||
    COALESCE(crm_notes, '')
  ) gin_trgm_ops
);

CREATE INDEX IF NOT EXISTS luma_event_guests_search_document_trgm_idx
ON luma_event_guests
USING GIN (
  LOWER(
    COALESCE(email, '') || ' ' ||
    COALESCE(profile_description, '') || ' ' ||
    COALESCE(search_text, '')
  ) gin_trgm_ops
);

CREATE INDEX IF NOT EXISTS luma_people_tags_jsonb_idx
ON luma_people
USING GIN (tags jsonb_path_ops);

CREATE INDEX IF NOT EXISTS luma_people_name_trgm_idx
ON luma_people
USING GIN (LOWER(name) gin_trgm_ops);
