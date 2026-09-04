UPDATE luma_event_guests
SET status = 'going'
WHERE status = 'no_show'
  AND luma_approval_status = 'approved'
  AND checked_in_at IS NULL;
