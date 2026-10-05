import {
  bulkInvitationStatus,
  parseInvitationPage,
} from "../../invite-tracking";
import { prisma } from "./db";

// Only selected events are queued. Repeated UI polling never resets an active cursor.
export async function requestBulkRefresh(
  eventIds: string[],
  manual = false,
  database: any = prisma(),
) {
  for (const eventId of [...new Set(eventIds)].slice(0, 20)) {
    const key = `bulk:${eventId}`;
    await database.lumaTrackingState.upsert({
      where: { key },
      create: { key, active: true },
      update: {},
    });
    await database.lumaTrackingState.updateMany({
      where: {
        key,
        active: false,
        ...(manual
          ? {}
          : { updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } }),
      },
      data: { active: true, cursor: null, leaseUntil: null, owner: null },
    });
  }
}

export async function fetchBulkPage(
  job: any,
  client: any,
  token: string,
  requestId: string,
  database: any,
) {
  const eventId = job.key.slice(5);
  const payload = await client.privateGet({
    requestId,
    lumaSessionToken: token,
    path: "/event/admin/get-invites",
    params: {
      event_api_id: eventId,
      pagination_limit: 20,
      ...(job.cursor ? { pagination_cursor: job.cursor } : {}),
    },
    operation: "bulk invitation tracking",
  });
  const page = parseInvitationPage(payload);
  if (page.hasMore && (page.cursor === job.cursor || !page.entries.length))
    throw new Error("Invitation pagination did not advance.");
  const emails = page.entries.map((e: any) => e.emailLower).filter(Boolean);
  const [guests, event, existing] = await Promise.all([
    database.lumaEventGuest.findMany({
      where: { eventId, emailLower: { in: emails } },
      select: { emailLower: true, personId: true },
    }),
    database.lumaEvent.findUnique({
      where: { eventId },
      select: { title: true, endsAt: true },
    }),
    database.lumaInviteTracking.findMany({
      where: { eventId, emailLower: { in: emails } },
    }),
  ]);
  const oldByEmail = new Map<string, any>(
    existing.map((row: any) => [row.emailLower, row]),
  );
  const unique = new Map<string, any>();
  for (const invite of page.entries) {
    if (
      invite.emailLower &&
      (!unique.has(invite.emailLower) ||
        unique.get(invite.emailLower).createdAt < invite.createdAt)
    )
      unique.set(invite.emailLower, invite);
  }
  // Commit observations and cursor together. Failed pages can be replayed safely.
  await database.$transaction(
    async (tx: any) => {
      const inserts = [];
      for (const invite of unique.values()) {
        if (!invite.emailLower) continue; // SMS invitations are not email delivery evidence.
        const old = oldByEmail.get(invite.emailLower);
        const previous = old?.bulkInvite as any;
        // Pages can contain multiple invitations for an address, newest first.
        const newest =
          previous?.createdAt && previous.createdAt > invite.createdAt
            ? previous
            : {
                ...invite,
                openedAt:
                  invite.openedAt ||
                  (previous?.id === invite.id ? previous.openedAt : null),
              };
        const data = {
          bulkInvite: newest,
          bulkCheckedAt: new Date(),
          status: bulkInvitationStatus(old, newest),
          personId:
            guests.find((g: any) => g.emailLower === invite.emailLower)
              ?.personId ||
            old?.personId ||
            null,
          lumaUserId: newest.userId || old?.lumaUserId || null,
          name: newest.name || old?.name || null,
          eventTitle: event?.title || old?.eventTitle || null,
        };
        if (old) {
          await tx.lumaInviteTracking.updateMany({
            where: {
              eventId,
              emailLower: invite.emailLower,
              requestedAt: old.requestedAt,
              updatedAt: old.updatedAt,
            },
            data,
          });
        } else {
          inserts.push({
            eventId,
            emailLower: invite.emailLower,
            ...data,
            nextCheckAt: null,
          });
        }
      }
      if (inserts.length)
        await tx.lumaInviteTracking.createMany({
          data: inserts,
          skipDuplicates: true,
        });
      await tx.lumaTrackingState.update({
        where: { key: job.key },
        data: {
          cursor: page.cursor,
          active: page.hasMore,
          leaseUntil:
            page.hasMore ||
            (event?.endsAt && event.endsAt.getTime() < Date.now() - 86400000)
              ? null
              : new Date(Date.now() + 15 * 60_000),
          owner: null,
        },
      });
    },
    { timeout: 20_000 },
  );
  return page.entries.length;
}
