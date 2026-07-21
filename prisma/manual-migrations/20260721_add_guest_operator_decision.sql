ALTER TABLE luma_event_guests
ADD COLUMN IF NOT EXISTS operator_decision TEXT;

CREATE INDEX IF NOT EXISTS luma_event_guests_event_id_status_operator_decision_idx
ON luma_event_guests (event_id, status, operator_decision);
