import { randomUUID } from "node:crypto";
import { prisma } from "../../../../luma/db";
import { apiError, authorize, fail, json, page, pagination } from "../../../shared";

const DEFAULT_EVENTS_PER_PAGE = 10;
export async function personEvents(
  request: Request,
  personId: string,
  db?: ReturnType<typeof prisma>,
) {
  const requestId = `integration-${randomUUID()}`;
  try {
    db ??= prisma();
    const key = await authorize(request, "guests:read", db);
    if (!key.scopes.includes("events:read")) fail("This API key requires events:read.", 403);
    if (!/^(?:guest:)?[a-z0-9_-]{1,160}$/i.test(personId)) fail("Provide a valid personId from an event guest response.");
    const { limit, cursor } = pagination(new URL(request.url).searchParams, [], {
      defaultLimit: DEFAULT_EVENTS_PER_PAGE,
    });
    let membership: Record<string, any> = { OR: [{ personId }, { lumaUserIdLower: personId.toLowerCase() }] };
    if (personId.startsWith("guest:")) {
      // Guest-only API IDs are event-local. Resolve the linked indexed person
      // within the key's event access before discovering their other events.
      const identity = await db.lumaEventGuest.findFirst({
        where: {
          lumaGuestId: personId.slice(6),
          ...(key.eventIds.length ? { eventId: { in: key.eventIds } } : {}),
        },
        select: { personId: true, lumaUserId: true },
      });
      if (!identity) return json({
        personId, data: [], pagination: { hasMore: false, nextCursor: null },
        source: "luma-index", coverage: "indexed-person-events",
        scannedEventCount: 0, loadedAt: new Date().toISOString(), requestId,
      });
      membership = { OR: [
        { personId: identity.personId },
        ...(identity.lumaUserId ? [{ lumaUserIdLower: identity.lumaUserId.toLowerCase() }] : []),
      ] };
    }
    const includeEmail = key.scopes.includes("guests:email");
    const rows = await db.lumaEvent.findMany({
      where: {
        guests: { some: membership },
        ...(key.eventIds.length
          ? { eventId: { in: key.eventIds, ...(cursor ? { gt: cursor } : {}) } }
          : cursor ? { eventId: { gt: cursor } } : {}),
      },
      orderBy: { eventId: "asc" },
      take: limit + 1,
      select: {
        eventId: true, title: true, date: true, startsAt: true, endsAt: true,
        location: true, lumaUrl: true, catalogActive: true,
        guests: {
          where: membership,
          orderBy: [{ syncedAt: "desc" }, { personId: "asc" }],
          take: 1,
          select: {
            personId: true, lumaUserId: true, lumaGuestId: true,
            status: true, lumaApprovalStatus: true, operatorDecision: true,
            registeredAt: true, invitedAt: true, approvedAt: true, checkedInAt: true,
            updatedAt: true, syncedAt: true,
            ...(includeEmail ? { email: true } : {}),
            person: { select: { name: true, lumaUserId: true, ...(includeEmail ? { email: true } : {}) } },
          },
        },
      },
    });
    const result = page(rows, limit, (row: { eventId: string }) => row.eventId);
    const data = result.data.flatMap((row: any) => {
      const { guests, ...event } = row;
      const guest = guests[0];
      // A membership can disappear between the event and relation reads.
      if (!guest) return [];
      const { person, email, personId: _indexedPersonId, lumaUserId: _lumaUserId, ...fields } = guest;
      // The public guest API uses guest:{id} for identities without a Luma user
      // ID. Internal index IDs can be email addresses and must not leak through
      // an identity field when a key cannot read email addresses.
      const publicPersonId = guest.lumaUserId || person.lumaUserId
        || (guest.lumaGuestId ? `guest:${guest.lumaGuestId}` : personId);
      const name = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.name || "") ? "Unnamed guest" : person.name || "Unnamed guest";
      return [{
        event, ...fields, personId: publicPersonId, name,
        status: guest.checkedInAt ? "checked_in" : guest.status || "unknown",
        checkedIn: Boolean(guest.checkedInAt || guest.status === "checked_in"),
        ...(includeEmail ? { email: email || person.email || null } : {}),
      }];
    });
    return json({
      personId,
      data,
      pagination: result.pagination,
      source: "luma-index",
      coverage: "indexed-person-events",
      scannedEventCount: result.data.length,
      loadedAt: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    const response = apiError(error);
    return json({ ...await response.json() as object, requestId }, response.status);
  }
}
