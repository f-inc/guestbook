CREATE INDEX IF NOT EXISTS luma_event_guests_person_activity_idx
ON luma_event_guests (
  person_id,
  checked_in_at DESC,
  registered_at DESC,
  created_at DESC,
  last_seen_at DESC
);

CREATE INDEX IF NOT EXISTS luma_event_guests_luma_user_activity_idx
ON luma_event_guests (
  luma_user_id_lower,
  checked_in_at DESC,
  registered_at DESC,
  created_at DESC,
  last_seen_at DESC
);

CREATE INDEX IF NOT EXISTS luma_event_guests_email_activity_idx
ON luma_event_guests (
  email_lower,
  checked_in_at DESC,
  registered_at DESC,
  created_at DESC,
  last_seen_at DESC
);
