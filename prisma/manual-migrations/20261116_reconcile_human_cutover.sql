-- PRE-ACTIVATION ONLY: pause every legacy writer and take a full backup first.
-- Reconcile legacy business edits without changing permanent human IDs or source
-- records. Never use this after admitting human-mode business writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(821157031);
LOCK TABLE luma_people,luma_event_guests,guest_comments,manual_tag_mutations,
  automatic_tag_assignments,person_merge_members,guest_tags,luma_events IN SHARE MODE;
LOCK TABLE guestbook_people,guestbook_comments,guestbook_manual_tag_mutations,
  guestbook_automatic_tag_assignments,guestbook_account_identities,
  guestbook_human_merges IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('guestbook.cutover_approved',true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Explicit pre-activation cutover approval is required';
  END IF;
  IF EXISTS(SELECT 1 FROM guestbook_human_merges)
    OR EXISTS(SELECT 1 FROM guestbook_people WHERE identity_version<>0 OR merged_into_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Human identities have changed; automatic legacy reconciliation is unsafe';
  END IF;
  IF EXISTS(SELECT 1 FROM luma_people p LEFT JOIN guestbook_account_identities i ON i.account_id=p.person_id WHERE i.account_id IS NULL)
    OR EXISTS(SELECT m.canonical_id FROM person_merge_members m JOIN guestbook_account_identities i ON i.account_id=m.person_id GROUP BY m.canonical_id HAVING count(DISTINCT i.person_id)>1) THEN
    RAISE EXCEPTION 'Reconcile source identity mappings before copying business records';
  END IF;
END $$;
-- Reflect current source profile values while keeping human IDs and mappings.
DO $$ DECLARE cols text; BEGIN
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols
  FROM pg_attribute WHERE attrelid='luma_people'::regclass AND attnum>0
    AND NOT attisdropped AND attgenerated='' AND attname<>'person_id';
  EXECUTE 'UPDATE guestbook_people h SET ('||cols||')=(SELECT '||cols||' FROM luma_people s WHERE s.person_id=h.primary_account_id)';
END $$;
WITH tags AS (
 SELECT i.person_id,jsonb_agg(DISTINCT tag) AS tags FROM guestbook_account_identities i
 JOIN luma_people p ON p.person_id=i.account_id CROSS JOIN LATERAL jsonb_array_elements(p.tags) tag GROUP BY i.person_id
), manual AS (
 SELECT i.person_id,jsonb_agg(DISTINCT tag) AS tags FROM guestbook_account_identities i
 JOIN luma_people p ON p.person_id=i.account_id CROSS JOIN LATERAL jsonb_array_elements(p.manual_tags) tag GROUP BY i.person_id
)
UPDATE guestbook_people h SET tags=COALESCE(tags.tags,'[]'::jsonb),manual_tags=COALESCE(manual.tags,'[]'::jsonb)
FROM guestbook_people existing LEFT JOIN tags ON tags.person_id=existing.person_id LEFT JOIN manual ON manual.person_id=existing.person_id
WHERE h.person_id=existing.person_id;
DELETE FROM guestbook_comments;
INSERT INTO guestbook_comments
SELECT (jsonb_populate_record(NULL::guestbook_comments,to_jsonb(s)||jsonb_build_object('person_id',i.person_id))).*
FROM guest_comments s JOIN guestbook_account_identities i ON i.account_id=s.person_id;
DELETE FROM guestbook_manual_tag_mutations;
INSERT INTO guestbook_manual_tag_mutations
SELECT (jsonb_populate_record(NULL::guestbook_manual_tag_mutations,to_jsonb(s)||jsonb_build_object('person_id',i.person_id))).*
FROM manual_tag_mutations s JOIN guestbook_account_identities i ON i.account_id=s.person_id;
DELETE FROM guestbook_automatic_tag_assignments;
INSERT INTO guestbook_automatic_tag_assignments
SELECT DISTINCT ON(i.person_id,s.rule_key) i.person_id,s.tag_id,s.rule_key,s.evidence,s.assigned_at,s.evaluated_at
FROM automatic_tag_assignments s JOIN guestbook_account_identities i ON i.account_id=s.person_id
ORDER BY i.person_id,s.rule_key,s.evaluated_at DESC;
SELECT setval('guestbook_comments_id_seq',COALESCE((SELECT MAX(id) FROM guestbook_comments),1),(SELECT count(*)>0 FROM guestbook_comments));
SELECT setval('guestbook_manual_tag_mutations_id_seq',COALESCE((SELECT MAX(id) FROM guestbook_manual_tag_mutations),1),(SELECT count(*)>0 FROM guestbook_manual_tag_mutations));
COMMIT;
