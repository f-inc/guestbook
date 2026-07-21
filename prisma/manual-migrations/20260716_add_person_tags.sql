ALTER TABLE luma_people
ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS guest_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0f766e',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE guest_tags
ALTER COLUMN created_at SET DEFAULT NOW(),
ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS guest_tags_name_lower_key
ON guest_tags (LOWER(name));

INSERT INTO guest_tags (id, name, color)
SELECT
  MD5(LOWER(tag_value)),
  MIN(tag_value),
  '#0f766e'
FROM luma_people
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
) AS tag_values(tag_value)
WHERE LENGTH(TRIM(tag_value)) > 0
GROUP BY LOWER(tag_value)
ON CONFLICT DO NOTHING;
