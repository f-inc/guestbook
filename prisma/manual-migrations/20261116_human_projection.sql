-- Companion to 20261116_add_human_identity.sql. Source tables are read-only here.
CREATE OR REPLACE FUNCTION guestbook_project_humans(ids text[], event_ids text[] DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(821157031);
  IF cardinality(ids)>1000 THEN RAISE EXCEPTION 'Human projection batch exceeds 1000'; END IF;
  PERFORM person_id FROM guestbook_people WHERE person_id=ANY(ids) ORDER BY person_id FOR UPDATE;
  INSERT INTO guestbook_person_emails(person_id,email_lower)
    SELECT identity.person_id,lower(trim(address.email))
    FROM guestbook_account_identities identity
    JOIN LATERAL (
      SELECT email FROM luma_people WHERE person_id=identity.account_id
      UNION SELECT email FROM luma_event_guests WHERE person_id=identity.account_id
    ) address ON true
    WHERE identity.person_id=ANY(ids) AND nullif(trim(address.email),'') IS NOT NULL
    ON CONFLICT DO NOTHING;
  UPDATE guestbook_people human SET
    search_aliases=COALESCE((SELECT string_agg(concat_ws(' ',account.name,account.email,account.phone_number,account.bio,account.social_links::text),' ') FROM guestbook_account_identities identity JOIN luma_people account ON account.person_id=identity.account_id WHERE identity.person_id=human.person_id),'')
      || ' ' || COALESCE((SELECT string_agg(email_lower,' ') FROM guestbook_person_emails WHERE person_id=human.person_id),''),
    last_seen_at=GREATEST(human.last_seen_at,account.last_seen_at),
    synced_at=GREATEST(human.synced_at,account.synced_at)
  FROM luma_people account WHERE human.person_id=ANY(ids) AND account.person_id=human.primary_account_id;
  -- A human/event row is a projection, not the source registration. Source IDs,
  -- every answer and every address remain available through account identities.
  DELETE FROM guestbook_event_guests WHERE person_id=ANY(ids) AND (event_ids IS NULL OR event_id=ANY(event_ids));
  INSERT INTO guestbook_event_guests
  SELECT (jsonb_populate_record(NULL::guestbook_event_guests, representative.payload || jsonb_build_object(
    'person_id',representative.human_id,
    'registered_at',history.registered_at,'invited_at',history.invited_at,'checked_in_at',history.checked_in_at,
    'registration_answers',history.answers,'social_links',history.socials,
    'search_text',history.search_text,'first_seen_at',history.first_seen_at,'last_seen_at',history.last_seen_at,
    'synced_at',history.synced_at,'metrics_derived_at',NULL
  ))).*
  FROM (
    SELECT DISTINCT ON (guest.event_id,identity.person_id)
      guest.event_id,identity.person_id AS human_id,to_jsonb(guest) AS payload
    FROM luma_event_guests guest JOIN guestbook_account_identities identity ON identity.account_id=guest.person_id
    WHERE identity.person_id=ANY(ids) AND (event_ids IS NULL OR guest.event_id=ANY(event_ids))
    ORDER BY guest.event_id,identity.person_id,
      (guest.checked_in_at IS NOT NULL OR guest.status='checked_in') DESC NULLS LAST,
      CASE guest.status WHEN 'going' THEN 5 WHEN 'registered' THEN 4 WHEN 'no_show' THEN 3 WHEN 'waitlisted' THEN 2 ELSE 1 END DESC,
      guest.last_seen_at DESC,guest.person_id
  ) representative
  JOIN LATERAL (
    SELECT MIN(guest.registered_at) registered_at,MIN(guest.invited_at) invited_at,MIN(guest.checked_in_at) checked_in_at,
      MIN(guest.first_seen_at) first_seen_at,MAX(guest.last_seen_at) last_seen_at,MAX(guest.synced_at) synced_at,
      string_agg(concat_ws(' ',guest.email,guest.search_text,guest.profile_description),' ') search_text,
      COALESCE((SELECT jsonb_agg(DISTINCT answer) FROM luma_event_guests g JOIN guestbook_account_identities i ON i.account_id=g.person_id CROSS JOIN LATERAL jsonb_array_elements(g.registration_answers) answer WHERE i.person_id=representative.human_id AND g.event_id=representative.event_id),'[]'::jsonb) answers,
      COALESCE((SELECT jsonb_agg(DISTINCT social) FROM luma_event_guests g JOIN guestbook_account_identities i ON i.account_id=g.person_id CROSS JOIN LATERAL jsonb_array_elements(g.social_links) social WHERE i.person_id=representative.human_id AND g.event_id=representative.event_id),'[]'::jsonb) socials
    FROM luma_event_guests guest JOIN guestbook_account_identities identity ON identity.account_id=guest.person_id
    WHERE identity.person_id=representative.human_id AND guest.event_id=representative.event_id
  ) history ON true;
  UPDATE guestbook_event_guests target SET
    has_prior_event=EXISTS(SELECT 1 FROM guestbook_event_guests prior JOIN luma_events earlier ON earlier.event_id=prior.event_id WHERE prior.person_id=target.person_id AND prior.event_id<>target.event_id AND COALESCE(earlier.starts_at,earlier.date::timestamptz)<COALESCE(current.starts_at,current.date::timestamptz)),
    is_referred=COALESCE((SELECT NOT mutation.removed FROM guestbook_manual_tag_mutations mutation JOIN guest_tags tag ON tag.id=mutation.tag_id WHERE mutation.person_id=target.person_id AND tag.semantic_key='referral' ORDER BY mutation.assigned_at DESC NULLS LAST,mutation.id DESC LIMIT 1),false),
    is_new_referral=COALESCE((SELECT mutation.assigned_event_id=target.event_id FROM guestbook_manual_tag_mutations mutation JOIN guest_tags tag ON tag.id=mutation.tag_id WHERE mutation.person_id=target.person_id AND tag.semantic_key='referral' AND NOT mutation.removed AND mutation.assigned_event_id IS NOT NULL ORDER BY mutation.assigned_at,mutation.id LIMIT 1),false),
    metrics_derived_at=now()
  FROM luma_events current WHERE target.person_id=ANY(ids) AND current.event_id=target.event_id;
END $$;
CREATE VIEW guestbook_human_person_email_addresses AS
 SELECT address.person_id,address.email_lower AS email FROM guestbook_person_emails address JOIN guestbook_people human ON human.person_id=address.person_id WHERE human.merged_into_id IS NULL
 UNION SELECT person_id,lower(trim(email)) FROM guestbook_active_people WHERE nullif(trim(email),'') IS NOT NULL
 UNION SELECT COALESCE(identity.person_id,tracking."personId"),lower(trim(tracking."emailLower")) FROM luma_invite_tracking tracking
 LEFT JOIN guestbook_account_identities identity ON identity.account_id=tracking."personId" WHERE tracking."personId" IS NOT NULL;
CREATE VIEW guestbook_human_inactive_people AS
 SELECT address.person_id FROM guestbook_human_person_email_addresses address
 LEFT JOIN email_inactive inactive ON inactive."emailLower"=address.email
 GROUP BY address.person_id HAVING COUNT(*) FILTER (WHERE inactive."emailLower" IS NULL)=0;
