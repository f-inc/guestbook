ALTER TABLE luma_events
ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS visibility TEXT;

UPDATE luma_events
SET
  ends_at = COALESCE(ends_at, NULLIF(raw->>'end_at', '')::TIMESTAMPTZ),
  visibility = COALESCE(visibility, NULLIF(raw->>'visibility', ''))
WHERE ends_at IS NULL OR visibility IS NULL;

CREATE INDEX IF NOT EXISTS luma_events_visibility_starts_at_idx
ON luma_events (visibility, starts_at DESC);

ALTER TABLE luma_people
ADD COLUMN IF NOT EXISTS manual_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS automatic_tags JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE luma_people
SET manual_tags = tags
WHERE jsonb_typeof(tags) = 'array'
  AND jsonb_array_length(tags) > 0
  AND jsonb_array_length(manual_tags) = 0
  AND jsonb_array_length(automatic_tags) = 0;

CREATE INDEX IF NOT EXISTS luma_people_tags_gin_idx
ON luma_people USING GIN (tags jsonb_path_ops);

CREATE OR REPLACE FUNCTION guestbook_replace_tag_name(source_tags JSONB, old_name TEXT, new_name TEXT)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(JSONB_AGG(deduped.replacement ORDER BY deduped.ordinality), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (LOWER(replacement)) replacement, ordinality
    FROM (
      SELECT
        CASE WHEN LOWER(item.value) = LOWER(old_name) THEN new_name ELSE item.value END AS replacement,
        item.ordinality
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(source_tags) = 'array' THEN source_tags ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS item(value, ordinality)
    ) AS replacements
    ORDER BY LOWER(replacement), ordinality
  ) AS deduped;
$$;

ALTER TABLE guest_tags
ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS rule_key TEXT;

DROP INDEX IF EXISTS guest_tags_rule_key_key;

CREATE UNIQUE INDEX guest_tags_rule_key_key
ON guest_tags (rule_key);

UPDATE luma_people
SET
  tags = guestbook_replace_tag_name(
    guestbook_replace_tag_name(
      guestbook_replace_tag_name(
        guestbook_replace_tag_name(
          guestbook_replace_tag_name(tags, 'Superpower User', '🚀 Superpower User'),
          'Power User', '⚡ Power User'
        ),
        'Festival Dweller', '🎪 Festival Dweller'
      ),
      'Flaker', '👻 Flaker'
    ),
    'Superflaker', '💀 Superflaker'
  ),
  manual_tags = guestbook_replace_tag_name(
    guestbook_replace_tag_name(
      guestbook_replace_tag_name(
        guestbook_replace_tag_name(
          guestbook_replace_tag_name(manual_tags, 'Superpower User', '🚀 Superpower User'),
          'Power User', '⚡ Power User'
        ),
        'Festival Dweller', '🎪 Festival Dweller'
      ),
      'Flaker', '👻 Flaker'
    ),
    'Superflaker', '💀 Superflaker'
  ),
  automatic_tags = guestbook_replace_tag_name(
    guestbook_replace_tag_name(
      guestbook_replace_tag_name(
        guestbook_replace_tag_name(
          guestbook_replace_tag_name(automatic_tags, 'Superpower User', '🚀 Superpower User'),
          'Power User', '⚡ Power User'
        ),
        'Festival Dweller', '🎪 Festival Dweller'
      ),
      'Flaker', '👻 Flaker'
    ),
    'Superflaker', '💀 Superflaker'
  );

WITH automatic_definitions(rule_key, name, legacy_name, color) AS (
  VALUES
    ('superpower_user', '🚀 Superpower User', 'Superpower User', '#7c3aed'),
    ('power_user', '⚡ Power User', 'Power User', '#dc2626'),
    ('festival_dweller', '🎪 Festival Dweller', 'Festival Dweller', '#d97706'),
    ('flaker', '👻 Flaker', 'Flaker', '#ca8a04'),
    ('superflaker', '💀 Superflaker', 'Superflaker', '#be123c')
)
UPDATE guest_tags AS tag
SET
  name = definition.name,
  managed = TRUE,
  rule_key = definition.rule_key,
  color = definition.color,
  updated_at = NOW()
FROM automatic_definitions AS definition
WHERE (tag.rule_key = definition.rule_key
    OR (tag.rule_key IS NULL AND LOWER(tag.name) IN (LOWER(definition.name), LOWER(definition.legacy_name))));

WITH automatic_definitions(rule_key, name, color) AS (
  VALUES
    ('superpower_user', '🚀 Superpower User', '#7c3aed'),
    ('power_user', '⚡ Power User', '#dc2626'),
    ('festival_dweller', '🎪 Festival Dweller', '#d97706'),
    ('flaker', '👻 Flaker', '#ca8a04'),
    ('superflaker', '💀 Superflaker', '#be123c')
)
INSERT INTO guest_tags (id, name, color, managed, rule_key, updated_at)
SELECT
  'auto-' || definition.rule_key,
  definition.name,
  definition.color,
  TRUE,
  definition.rule_key,
  NOW()
FROM automatic_definitions AS definition
WHERE NOT EXISTS (
  SELECT 1
  FROM guest_tags AS tag
  WHERE tag.rule_key = definition.rule_key
     OR LOWER(tag.name) = LOWER(definition.name)
)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS automatic_tag_assignments (
  person_id TEXT NOT NULL REFERENCES luma_people(person_id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES guest_tags(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person_id, rule_key)
);

CREATE INDEX IF NOT EXISTS automatic_tag_assignments_tag_id_person_id_idx
ON automatic_tag_assignments (tag_id, person_id);

CREATE INDEX IF NOT EXISTS automatic_tag_assignments_person_id_idx
ON automatic_tag_assignments (person_id);

CREATE TABLE IF NOT EXISTS automatic_tag_state (
  id TEXT PRIMARY KEY,
  public_event_fingerprint TEXT NOT NULL DEFAULT '',
  last_mode TEXT,
  last_evaluated_count INTEGER NOT NULL DEFAULT 0,
  last_changed_count INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
