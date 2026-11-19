-- PREPARE/REVIEW ONLY. Requires explicit production authorization, a data backup,
-- and paused source writers during the backfill. Do not use prisma db push.
-- Existing source tables, merge ledger, and registrations are retained unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(821157031);
CREATE TABLE guestbook_people (LIKE luma_people INCLUDING ALL EXCLUDING IDENTITY);
ALTER TABLE guestbook_people ADD COLUMN primary_account_id text, ADD COLUMN merged_into_id text,
  ADD COLUMN identity_version integer NOT NULL DEFAULT 0, ADD COLUMN search_aliases text NOT NULL DEFAULT '';
CREATE TABLE guestbook_event_guests (LIKE luma_event_guests INCLUDING ALL EXCLUDING IDENTITY);
CREATE TABLE guestbook_comments (LIKE guest_comments INCLUDING ALL EXCLUDING IDENTITY);
CREATE TABLE guestbook_manual_tag_mutations (LIKE manual_tag_mutations INCLUDING ALL EXCLUDING IDENTITY);
CREATE TABLE guestbook_automatic_tag_assignments (LIKE automatic_tag_assignments INCLUDING ALL EXCLUDING IDENTITY);
CREATE SEQUENCE guestbook_comments_id_seq OWNED BY guestbook_comments.id;
ALTER TABLE guestbook_comments ALTER COLUMN id SET DEFAULT nextval('guestbook_comments_id_seq');
CREATE SEQUENCE guestbook_manual_tag_mutations_id_seq OWNED BY guestbook_manual_tag_mutations.id;
ALTER TABLE guestbook_manual_tag_mutations ALTER COLUMN id SET DEFAULT nextval('guestbook_manual_tag_mutations_id_seq');
CREATE TABLE guestbook_account_identities (
  account_id text PRIMARY KEY REFERENCES luma_people(person_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  person_id text NOT NULL REFERENCES guestbook_people(person_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guestbook_account_identities_person_id_idx ON guestbook_account_identities(person_id);
CREATE TABLE guestbook_person_emails (
  person_id text NOT NULL REFERENCES guestbook_people(person_id) ON DELETE CASCADE ON UPDATE CASCADE,
  email_lower text NOT NULL,
  PRIMARY KEY(person_id,email_lower)
);
CREATE INDEX guestbook_person_emails_email_lower_idx ON guestbook_person_emails(email_lower);
CREATE TABLE guestbook_human_merges (
  id text PRIMARY KEY, before jsonb NOT NULL, after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), undone_at timestamptz
);
CREATE TEMP TABLE human_groups ON COMMIT DROP AS
SELECT group_id, 'human_' || gen_random_uuid()::text AS human_id
FROM (SELECT DISTINCT COALESCE(m.canonical_id,p.person_id) AS group_id FROM luma_people p
LEFT JOIN person_merge_members m ON m.person_id=p.person_id) groups;
CREATE TEMP TABLE human_accounts ON COMMIT DROP AS
SELECT p.person_id AS account_id,g.human_id,g.group_id FROM luma_people p
LEFT JOIN person_merge_members m ON m.person_id=p.person_id
JOIN human_groups g ON g.group_id=COALESCE(m.canonical_id,p.person_id);
-- The tag copy looks up accounts by human for every profile. Index the temporary
-- mapping so production-size imports do not repeatedly scan the full roster.
CREATE INDEX ON human_accounts(human_id);
ANALYZE human_accounts;
-- Copy primary profiles using shared source columns, including optional generated
-- columns only through their defaults. This does not depend on deployment drift.
DO $$ DECLARE cols text; BEGIN
SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols
FROM pg_attribute WHERE attrelid='luma_people'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='';
EXECUTE 'INSERT INTO guestbook_people ('||cols||') SELECT '||cols||' FROM luma_people WHERE person_id IN (SELECT group_id FROM human_groups)';
END $$;
UPDATE guestbook_people p SET primary_account_id=p.person_id,person_id=g.human_id FROM human_groups g WHERE p.person_id=g.group_id;
ALTER TABLE guestbook_people ADD CONSTRAINT guestbook_people_human_id CHECK (person_id ~ '^human_[0-9a-f-]{36}$');
INSERT INTO guestbook_account_identities(account_id,person_id) SELECT account_id,human_id FROM human_accounts;
-- Human-owned notes and tag history preserve their IDs and original content.
INSERT INTO guestbook_comments SELECT c.* FROM guest_comments c;
UPDATE guestbook_comments c SET person_id=a.human_id FROM human_accounts a WHERE c.person_id=a.account_id;
INSERT INTO guestbook_manual_tag_mutations SELECT m.* FROM manual_tag_mutations m;
UPDATE guestbook_manual_tag_mutations m SET person_id=a.human_id FROM human_accounts a WHERE m.person_id=a.account_id;
INSERT INTO guestbook_automatic_tag_assignments
SELECT DISTINCT ON (a.human_id,t.rule_key) a.human_id,t.tag_id,t.rule_key,t.evidence,t.assigned_at,t.evaluated_at
FROM automatic_tag_assignments t JOIN human_accounts a ON a.account_id=t.person_id
ORDER BY a.human_id,t.rule_key,t.evaluated_at DESC;
SELECT setval('guestbook_comments_id_seq',COALESCE((SELECT MAX(id) FROM guestbook_comments),1),(SELECT count(*)>0 FROM guestbook_comments));
SELECT setval('guestbook_manual_tag_mutations_id_seq',COALESCE((SELECT MAX(id) FROM guestbook_manual_tag_mutations),1),(SELECT count(*)>0 FROM guestbook_manual_tag_mutations));
ALTER TABLE guestbook_event_guests ADD FOREIGN KEY(person_id) REFERENCES guestbook_people(person_id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD FOREIGN KEY(event_id) REFERENCES luma_events(event_id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE guestbook_comments ADD FOREIGN KEY(person_id) REFERENCES guestbook_people(person_id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE guestbook_manual_tag_mutations ADD FOREIGN KEY(person_id) REFERENCES guestbook_people(person_id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD FOREIGN KEY(tag_id) REFERENCES guest_tags(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD FOREIGN KEY(assigned_event_id) REFERENCES luma_events(event_id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE guestbook_automatic_tag_assignments ADD FOREIGN KEY(person_id) REFERENCES guestbook_people(person_id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD FOREIGN KEY(tag_id) REFERENCES guest_tags(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE VIEW guestbook_active_people WITH (security_invoker = true) AS SELECT * FROM guestbook_people WHERE merged_into_id IS NULL;
UPDATE guestbook_people h SET
 manual_tags=(SELECT COALESCE(jsonb_agg(DISTINCT tag),'[]'::jsonb) FROM human_accounts a JOIN luma_people p ON p.person_id=a.account_id CROSS JOIN LATERAL jsonb_array_elements(p.manual_tags) tag WHERE a.human_id=h.person_id),
 tags=(SELECT COALESCE(jsonb_agg(DISTINCT tag),'[]'::jsonb) FROM human_accounts a JOIN luma_people p ON p.person_id=a.account_id CROSS JOIN LATERAL jsonb_array_elements(p.tags) tag WHERE a.human_id=h.person_id);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX guestbook_people_aliases_idx ON guestbook_people USING gin (search_aliases gin_trgm_ops);
CREATE INDEX guestbook_people_merged_into_idx ON guestbook_people(merged_into_id);
COMMIT;
-- Apply the companion projection function file, then run the bounded backfill
-- script and validate its manifest BEFORE enabling GUESTBOOK_IDENTITY_MODE=human.
