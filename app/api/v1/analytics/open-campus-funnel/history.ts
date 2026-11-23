import { GUEST_REGISTERED_STATUSES } from "../../../luma/guest-query";
import { Prisma } from "@prisma/client";
import { fail } from "../../shared";
export async function loadFunnelHistory(tx: Prisma.TransactionClient, historyScope: string[]) {
  const events = await tx.lumaEvent.findMany({
    where: { ...(historyScope.length ? { eventId: { in: historyScope } } : {}) },
    orderBy: { eventId: "asc" },
    take: 2001,
    select: {
      eventId: true,
      title: true,
      location: true,
      category: true,
      startsAt: true,
      date: true,
      endsAt: true,
      syncState: { select: { lastGuestSyncAt: true, lastStatus: true, truncated: true } },
    },
  });
  if (events.length > 2000) fail("Funnel event history exceeds its read limit.", 503);
  const ids = events.map((event) => event.eventId);
  const guests = ids.length
    ? await tx.lumaEventGuest.findMany({
        where: {
          eventId: { in: ids },
          OR: [
            { checkedInAt: { not: null } },
            { status: "checked_in" },
            {
              eventId: {
                in: events
                  .filter((event) => /\bopen\s+campus\b/i.test(event.title))
                  .map((event) => event.eventId),
              },
              OR: [
                { registeredAt: { not: null } },
                { approvedAt: { not: null } },
                { status: { in: GUEST_REGISTERED_STATUSES } },
              ],
            },
          ],
        },
        orderBy: [{ eventId: "asc" }, { personId: "asc" }],
        take: 100001,
        select: {
          eventId: true,
          personId: true,
          person: { select: { name: true } },
          emailLower: true,
          registeredAt: true,
          approvedAt: true,
          checkedInAt: true,
          status: true,
          hasPriorEvent: true,
        },
      })
    : [];
  if (guests.length > 100000) fail("Funnel guest history exceeds its read limit.", 503);

  return { events, guests };
}
