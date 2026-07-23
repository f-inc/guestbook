CREATE TABLE IF NOT EXISTS super_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#38bdf8',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS super_tags_name_lower_key
ON super_tags (LOWER(name));

CREATE TABLE IF NOT EXISTS super_tag_rules (
  id BIGSERIAL PRIMARY KEY,
  super_tag_id TEXT NOT NULL REFERENCES super_tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('tag_exact', 'tag', 'event')),
  phrase TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS super_tag_rules_super_tag_id_idx
ON super_tag_rules (super_tag_id);

CREATE UNIQUE INDEX IF NOT EXISTS super_tag_rules_unique_rule
ON super_tag_rules (super_tag_id, source, LOWER(phrase));
