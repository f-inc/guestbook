import { prisma } from "../../luma/db";
import { apiError, authorize, json, page, pagination } from "../shared";
export async function events(request: Request, db?: ReturnType<typeof prisma>) {
  try {
    db ??= prisma();
    const key = await authorize(request, "events:read", db);
    const { limit, cursor } = pagination(new URL(request.url).searchParams);
    const rows = await db.lumaEvent.findMany({
      where: { ...(key.eventIds.length ? { eventId: { in: key.eventIds, ...(cursor ? { gt: cursor } : {}) } } : cursor ? { eventId: { gt: cursor } } : {}) },
      orderBy: { eventId: "asc" }, take: limit + 1,
      select: { eventId: true, title: true, date: true, startsAt: true, endsAt: true, visibility: true, location: true, category: true, capacity: true, lumaUrl: true, catalogActive: true, syncedAt: true,
        syncState: { select: { lastGuestSyncAt: true, lastStatus: true, truncated: true } } },
    });
    return json(page(rows, limit, (row: { eventId: string }) => row.eventId));
  } catch (error) { return apiError(error); }
}
