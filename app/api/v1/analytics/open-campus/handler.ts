import { prisma, readIndexedOpenCampusTotals } from "../../../luma/db";
import { apiError, authorize, fail, json } from "../../shared";

// Counts only: no calendar guest scans, index refreshes, or personal data.
export async function openCampusAnalytics(request: Request, db?: ReturnType<typeof prisma>, now = new Date()) {
  try {
    db ??= prisma();
    const key = await authorize(request, "events:read", db);
    if (!key.scopes.includes("guests:read")) fail("This API key requires guests:read.", 403);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(name => !["period", "from", "to"].includes(name)) ||
        ["period", "from", "to"].some(name => params.getAll(name).length > 1)) fail("Invalid analytics query.");
    const period = params.get("period") ?? "all";
    if (!["all", "30d"].includes(period)) fail("period must be all or 30d.");
    const from = params.get("from");
    const to = params.get("to");
    const validDate = (value: string | null): value is string => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || (value < "1900-01-01" || value >= "9999-12-31")) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    const custom = from !== null || to !== null;
    if (custom && (!validDate(from) || !validDate(to) || from > to || params.has("period"))) fail("Choose both dates in order, or a preset.");
    const since = new Date(now.getTime() - 30 * 86400000);
    const start = custom ? pacificMidnight(from!) : since;
    const end = custom ? pacificMidnight(nextDay(to!)) : now;
    const candidates = await db.lumaEvent.findMany({
      where: {
        title: { contains: "open campus", mode: "insensitive" },
        ...(key.eventIds.length ? { eventId: { in: key.eventIds } } : {}),
        ...(custom ? { OR: [
          { startsAt: { gte: start, lt: end, lte: now } },
          // Date-only fallbacks are stored as UTC calendar dates, not instants.
          { startsAt: null, date: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${nextDay(to!)}T00:00:00Z`), lte: now } },
        ] } : period === "30d" ? { OR: [
          { startsAt: { gte: since, lte: now } },
          { startsAt: null, date: { gte: since, lte: now } },
        ] } : {}),
      },
      take: 501,
      select: {
        eventId: true, title: true,
        syncState: { select: { lastGuestSyncAt: true, lastStatus: true, truncated: true } },
      },
    });
    if (candidates.length > 500) fail("Open Campus event limit exceeded. Narrow this API key's event access.", 503);
    const events = candidates.filter(event => /\bopen campus\b/i.test(event.title));
    let updatedAt: Date | null = null;
    for (const event of events) {
      const sync = event.syncState;
      if (!sync?.lastGuestSyncAt || !["success", "skipped_fresh"].includes(sync.lastStatus || "") || sync.truncated) {
        fail("Open Campus analytics requires complete indexed events. Refresh Open Campus events in Guestbook.", 503);
      }
      if (!updatedAt || sync.lastGuestSyncAt < updatedAt) updatedAt = sync.lastGuestSyncAt;
    }
    const totals = await readIndexedOpenCampusTotals(events.map(event => event.eventId), db, key.eventIds);
    return json({ data: { ...totals, eventCount: events.length, updatedAt: updatedAt?.toISOString() ?? null }, source: "guestbook-index", complete: true });
  } catch (error) { return apiError(error); }
}


function nextDay(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/** Calendar midnight in Pacific time; recompute offset at the target to handle DST. */
function pacificMidnight(day: string) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let result = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" });
  for (let pass = 0; pass < 2; pass++) {
    const zone = formatter.formatToParts(new Date(result)).find(part => part.type === "timeZoneName")!.value;
    const hours = Number(zone.replace("GMT", ""));
    result = target - hours * 3600000;
  }
  return new Date(result);
}
