import { Prisma } from "@prisma/client";
import type { FunnelEvent, FunnelGuest } from "../v1/analytics/open-campus-funnel/cohort";

/** New is relative to this event visit, not to an invitation or registration. */
export function isNewEventAttendee(row: FunnelGuest, history: FunnelGuest[], events: Map<string, FunnelEvent>) {
  const cutoff = row.checkedInAt ?? events.get(row.eventId)?.startsAt ?? events.get(row.eventId)?.date;
  if (!cutoff) return false;
  return !history.some(previous => {
    if (previous.eventId === row.eventId || (!previous.checkedInAt && previous.status !== "checked_in")) return false;
    const attended = previous.checkedInAt ?? events.get(previous.eventId)?.startsAt ?? events.get(previous.eventId)?.date;
    // Unknown attendance dates cannot establish that this was a first visit.
    return !attended || attended < cutoff;
  });
}

/** Shared by the Open Campus aggregate and native Guestbook table filters. */
export function newEventAttendeeSql() {
  return Prisma.sql`(
    COALESCE(guest.checked_in_at, (SELECT COALESCE(current_event.starts_at, current_event.date::timestamptz)
      FROM luma_events current_event WHERE current_event.event_id = guest.event_id)) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM luma_event_guests previous_guest
      LEFT JOIN luma_events previous_event ON previous_event.event_id = previous_guest.event_id
      WHERE previous_guest.person_id = guest.person_id AND previous_guest.event_id <> guest.event_id
        AND (previous_guest.checked_in_at IS NOT NULL OR previous_guest.status = 'checked_in')
        AND (COALESCE(previous_guest.checked_in_at, previous_event.starts_at, previous_event.date::timestamptz) IS NULL
          OR COALESCE(previous_guest.checked_in_at, previous_event.starts_at, previous_event.date::timestamptz)
            < COALESCE(guest.checked_in_at, (SELECT COALESCE(current_event.starts_at, current_event.date::timestamptz)
              FROM luma_events current_event WHERE current_event.event_id = guest.event_id)))
    )
  )`;
}
