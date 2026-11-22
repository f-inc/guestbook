import { Prisma } from "@prisma/client";
import { prisma } from "../../../luma/db";
import { GUEST_ACCEPTED_STATUSES, GUEST_REGISTERED_STATUSES } from "../../../luma/guest-query";
import { apiError, authorize, fail, json } from "../../shared";

const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
const validDate = (value: string | null): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// Read only indexed summaries. Never scan live Luma guests or refresh the index here.
export async function eventAnalytics(request: Request, db?: ReturnType<typeof prisma>) {
  try {
    db ??= prisma();
    const key = await authorize(request, "events:read", db);
    if (!key.scopes.includes("guests:read")) fail("This API key requires guests:read.", 403);
    const params = new URL(request.url).searchParams;
    for (const name of params.keys()) if (!["from", "to"].includes(name) || params.getAll(name).length !== 1) fail("Invalid query parameters.");
    const from = params.get("from"), to = params.get("to");
    if (!validDate(from) || !validDate(to) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail("Choose valid dates spanning up to one year; to is exclusive.");
    const data = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const rows = await tx.lumaEvent.findMany({
        where: { ...(key.eventIds.length ? { eventId: { in: key.eventIds } } : {}), startsAt: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(Date.parse(to) + 86400000) } },
        orderBy: { eventId: "asc" }, take: 501,
        select: { eventId: true, title: true, startsAt: true, endsAt: true, location: true, category: true, capacity: true, catalogActive: true,
          syncState: { select: { lastGuestSyncAt: true, lastStatus: true, truncated: true } } },
      });
      if (rows.length > 500) fail("Event analytics limit exceeded. Choose a shorter date range.", 503);
      const events = rows.filter(event => event.startsAt && day.format(event.startsAt) >= from && day.format(event.startsAt) < to);
      const ready = events.filter(event => event.syncState?.lastGuestSyncAt && ["success", "skipped_fresh"].includes(event.syncState.lastStatus || "") && !event.syncState.truncated);
      const ids = ready.map(event => event.eventId);
      const counts = ids.length ? await tx.$queryRaw<Array<{ eventId: string; registrations: number; accepted: number; checkedIn: number }>>(Prisma.sql`
        SELECT guest.event_id AS "eventId",
          COUNT(*) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_REGISTERED_STATUSES)}) OR (guest.status = 'declined' AND guest.registered_at IS NOT NULL))::integer AS registrations,
          COUNT(*) FILTER (WHERE guest.status IN (${Prisma.join(GUEST_ACCEPTED_STATUSES)}))::integer AS accepted,
          COUNT(*) FILTER (WHERE guest.checked_in_at IS NOT NULL OR guest.status = 'checked_in')::integer AS "checkedIn"
        FROM luma_event_guests AS guest WHERE guest.event_id IN (${Prisma.join(ids)}) GROUP BY guest.event_id
      `) : [];
      const indexed = new Map(counts.map(row => [row.eventId, row]));
      const readyIds = new Set(ids);
      return events.map(event => ({
        id: event.eventId, title: event.title, start: event.startsAt!.toISOString(), end: event.endsAt?.toISOString() ?? null,
        location: event.location || "", category: event.category || "Other events", capacity: event.capacity, catalogActive: event.catalogActive,
        attendance: readyIds.has(event.eventId) ? {
          registrations: indexed.get(event.eventId)?.registrations ?? 0,
          accepted: indexed.get(event.eventId)?.accepted ?? 0,
          checkedIn: indexed.get(event.eventId)?.checkedIn ?? 0,
          updatedAt: event.syncState!.lastGuestSyncAt!.toISOString(),
        } : null,
      }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return json({ data, source: "guestbook-index", complete: true });
  } catch (error) { return apiError(error); }
}
