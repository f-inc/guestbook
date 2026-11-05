-- Apply separately with explicit production approval, outside a transaction.
-- Additive: retain the legacy index and column for compatibility and recovery.
-- IF NOT EXISTS does not repair an invalid index from an interrupted build:
-- check pg_index.indisvalid before considering a retry successful.
CREATE INDEX CONCURRENTLY IF NOT EXISTS luma_people_search_document_v2_trgm_idx
ON luma_people
USING GIN (
  LOWER(
    COALESCE(name, '') || ' ' ||
    COALESCE(email, '') || ' ' ||
    COALESCE(title, '') || ' ' ||
    COALESCE(bio, '')
  ) gin_trgm_ops
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS guest_comments_body_trgm_idx
ON guest_comments
USING GIN (LOWER(body) gin_trgm_ops);
