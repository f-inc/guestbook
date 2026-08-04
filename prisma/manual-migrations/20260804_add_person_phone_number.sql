ALTER TABLE luma_people
ADD COLUMN IF NOT EXISTS phone_number TEXT;

UPDATE luma_people AS person
SET phone_number = existing_phone.phone_number
FROM (
  SELECT DISTINCT ON (guest.person_id)
    guest.person_id,
    guest.phone_number
  FROM luma_event_guests AS guest
  LEFT JOIN luma_events AS event ON event.event_id = guest.event_id
  WHERE NULLIF(BTRIM(guest.phone_number), '') IS NOT NULL
  ORDER BY
    guest.person_id,
    event.starts_at DESC NULLS LAST,
    event.date DESC NULLS LAST,
    guest.last_seen_at DESC
) AS existing_phone
WHERE person.person_id = existing_phone.person_id
  AND NULLIF(BTRIM(person.phone_number), '') IS NULL;
