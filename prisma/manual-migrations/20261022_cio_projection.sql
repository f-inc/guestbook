-- PREPARED ONLY. Apply only to the explicitly approved target, after a backup.
-- Additive durable queue. No Customer.io requests, contact backfill or sends.
BEGIN;
CREATE TABLE cio_projection_queue (
  email text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1,
  sent_revision bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  priority integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  pending_since timestamptz DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  payload_hash text,
  last_synced_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cio_projection_pending ON cio_projection_queue(next_attempt_at) WHERE revision > sent_revision;
CREATE TABLE cio_sync_control (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}',
  owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION cio_mark_email(raw_email text, urgent boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE email_key text := lower(btrim(raw_email));
BEGIN
  IF email_key IS NULL OR email_key !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RETURN; END IF;
  INSERT INTO cio_projection_queue(email, priority) VALUES(email_key, CASE WHEN urgent THEN 1 ELSE 0 END)
  ON CONFLICT(email) DO UPDATE SET revision = cio_projection_queue.revision + 1,
    priority = greatest(cio_projection_queue.priority, excluded.priority),
    pending_since = CASE WHEN cio_projection_queue.revision > cio_projection_queue.sent_revision
      THEN coalesce(cio_projection_queue.pending_since, now()) ELSE now() END,
    attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now();
END $$;

CREATE FUNCTION cio_changed_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; email_key text; coverage_cutoff timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  -- A poll which only refreshed cache timestamps must not restart a failed job.
  IF TG_OP = 'UPDATE' AND
    (old_row - ARRAY['synced_at','last_seen_at','metrics_derived_at','updated_at','lumaCheckedAt']) =
    (new_row - ARRAY['synced_at','last_seen_at','metrics_derived_at','updated_at','lumaCheckedAt']) THEN
    -- A newly observed registration can reappear after a complete CIO scan
    -- excluded it. Preserve that transition even if only last_seen_at changed.
    IF TG_TABLE_NAME = 'luma_event_guests' THEN
      SELECT (data->>'completedBefore')::timestamptz INTO coverage_cutoff
        FROM cio_sync_control WHERE id = 'coverage:' || (new_row->>'event_id');
    END IF;
    IF coverage_cutoff IS NULL OR NOT (
      (old_row->>'last_seen_at')::timestamptz < coverage_cutoff AND
      (new_row->>'last_seen_at')::timestamptz >= coverage_cutoff
    ) THEN RETURN NEW; END IF;
  END IF;
  -- Profile descriptions and classifier tags are not owned by this adapter.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'luma_people' AND
    old_row->>'email_lower' IS NOT DISTINCT FROM new_row->>'email_lower' THEN RETURN NEW; END IF;
  IF old_row IS NOT NULL THEN PERFORM cio_mark_email(coalesce(old_row->>'email_lower', old_row->>'emailLower', old_row->>'email'), TG_TABLE_NAME <> 'luma_event_guests'); END IF;
  IF new_row IS NOT NULL THEN PERFORM cio_mark_email(coalesce(new_row->>'email_lower', new_row->>'emailLower', new_row->>'email'), TG_TABLE_NAME <> 'luma_event_guests'); END IF;
  IF TG_TABLE_NAME = 'luma_people' THEN
    FOR email_key IN SELECT DISTINCT email_lower FROM luma_event_guests
      WHERE person_id = coalesce(new_row->>'person_id', old_row->>'person_id') LOOP
      PERFORM cio_mark_email(email_key);
    END LOOP;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE FUNCTION cio_changed_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_key text; email_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'luma_event_sync_state' AND
     (to_jsonb(OLD) - ARRAY['last_guest_sync_at','last_event_sync_at','last_webhook_at','last_webhook_id','updated_at']) =
     (to_jsonb(NEW) - ARRAY['last_guest_sync_at','last_event_sync_at','last_webhook_at','last_webhook_id','updated_at']) AND
     (to_jsonb(OLD)->>'last_guest_sync_at' IS NULL) = (to_jsonb(NEW)->>'last_guest_sync_at' IS NULL)
     THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'luma_events' AND
     (to_jsonb(OLD) - ARRAY['synced_at','last_seen_at','overview_stats','overview_stats_updated_at','feedback_average_rating','feedback_rating_count','feedback_stats_updated_at']) =
     (to_jsonb(NEW) - ARRAY['synced_at','last_seen_at','overview_stats','overview_stats_updated_at','feedback_average_rating','feedback_rating_count','feedback_stats_updated_at']) THEN RETURN NEW; END IF;
  event_key := coalesce(to_jsonb(NEW)->>'event_id', to_jsonb(OLD)->>'event_id');
  FOR email_key IN SELECT DISTINCT email_lower FROM luma_event_guests WHERE event_id = event_key LOOP
    PERFORM cio_mark_email(email_key);
  END LOOP;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER cio_guest_changed AFTER INSERT OR UPDATE OR DELETE ON luma_event_guests FOR EACH ROW EXECUTE FUNCTION cio_changed_email();
CREATE TRIGGER cio_person_changed AFTER INSERT OR UPDATE OR DELETE ON luma_people FOR EACH ROW EXECUTE FUNCTION cio_changed_email();
CREATE TRIGGER cio_event_changed AFTER UPDATE ON luma_events FOR EACH ROW EXECUTE FUNCTION cio_changed_event();
CREATE TRIGGER cio_completeness_changed AFTER INSERT OR UPDATE OR DELETE ON luma_event_sync_state FOR EACH ROW EXECUTE FUNCTION cio_changed_event();
CREATE TRIGGER cio_opt_out_changed AFTER INSERT OR UPDATE OR DELETE ON luma_calendar_opt_outs FOR EACH ROW EXECUTE FUNCTION cio_changed_email();
CREATE TRIGGER cio_address_changed AFTER INSERT OR UPDATE OR DELETE ON email_addresses FOR EACH ROW EXECUTE FUNCTION cio_changed_email();
CREATE TRIGGER cio_inactivity_changed AFTER INSERT OR UPDATE OR DELETE ON email_inactive FOR EACH ROW EXECUTE FUNCTION cio_changed_email();
COMMIT;
