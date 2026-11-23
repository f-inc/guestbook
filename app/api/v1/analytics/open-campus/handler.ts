import { loadFunnelHistory } from "../open-campus-funnel/history";
import { evaluateRecipientMatches, type Recipient } from "./recipients";
import { prisma, readIndexedOpenCampusTotals } from "../../../luma/db";
import { apiError, authorize, fail, json } from "../../shared";

// Counts only: no calendar guest scans, index refreshes, or personal data.
export async function openCampusAnalytics(request: Request, db?: ReturnType<typeof prisma>, now = new Date()) {
  try {
    db ??= prisma();
    const key = await authorize(request, "events:read", db);
    if (!key.scopes.includes("guests:read")) fail("This API key requires guests:read.", 403);
    let matching: { nonce: string; recipients: Recipient[] } | null = null;
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) fail("JSON required.", 415);
      const reader = request.body?.getReader();
      if (!reader) fail("Recipient payload required.");
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 131072) { await reader.cancel(); fail("Recipient payload too large.", 413); }
        chunks.push(value);
      }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("Invalid recipient payload."); }
      if (!body || Object.keys(body).some(name => !["nonce", "recipients"].includes(name)) ||
          typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce) || !Array.isArray(body.recipients) || body.recipients.length > 1000 ||
          body.recipients.some((r: any) => !r || Object.keys(r).some(name => !["token", "nameTokens", "receivedAt"].includes(name)) ||
            (r.nameTokens !== undefined && (!Array.isArray(r.nameTokens) || r.nameTokens.length > 2 || r.nameTokens.some((token: unknown) => typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)))) ||
            typeof r.token !== "string" || !/^[a-f0-9]{64}$/.test(r.token) || typeof r.receivedAt !== "string" ||
            !Number.isFinite(Date.parse(r.receivedAt)) || new Date(r.receivedAt).toISOString() !== r.receivedAt || Date.parse(r.receivedAt) > now.getTime())) fail("Invalid recipient payload.");
      matching = body;
    }
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
        catalogActive: true,
        title: { contains: "open campus", mode: "insensitive" },
        ...(key.eventIds.length ? { eventId: { in: key.eventIds } } : {}),
        ...(custom ? { OR: [
          { startsAt: { gte: start, lt: end, lte: now } },
          // Date-only fallbacks are stored as UTC calendar dates, not instants.
          { startsAt: null, date: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${nextDay(to!)}T00:00:00Z`), lte: now } },
        ] } : period === "30d" ? { OR: [
          { startsAt: { gte: since, lte: now } },
          { startsAt: null, date: { gte: since, lte: now } },
        ] } : { OR: [
          { startsAt: { lte: now } },
          { startsAt: null, date: { lte: now } },
        ] }),
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
    const totals = await readIndexedOpenCampusTotals(events.map(event => event.eventId), db);
    const guestPassMatches = matching ? await db.$transaction(async tx => {
      const history = await loadFunnelHistory(tx, key.eventIds);
      return evaluateRecipientMatches(history.events, history.guests, events.map(event => event.eventId), matching!.recipients,
        request.headers.get("authorization")!.slice(7), matching!.nonce, now);
    }, { isolationLevel: "RepeatableRead", timeout: 15000 }) : undefined;
    const drilldownLinks: Record<string, string> = {};
    const filters = { registrations: "registered", accepted: "accepted", checkedIn: "checked_in" };
    const newFilters = { registrations: "new_attendee_registered", accepted: "new_attendee_accepted", checkedIn: "new_attendee_checked_in" };
    for (const stage of ["registrations", "accepted", "checkedIn"] as const) {
      for (const newOnly of [false, true]) {
        const total = newOnly ? totals.newPeople?.[stage] : totals[stage];
        if (total === null || total === undefined || !events.length) continue;
        const params = new URLSearchParams({ event_view: "all", tab: "overview", guest_status: newOnly ? newFilters[stage] : filters[stage] });
        for (const event of events) params.append("event", event.eventId);
        drilldownLinks[newOnly ? `new${stage[0].toUpperCase()}${stage.slice(1)}` : stage] = `/?${params}`;
      }
    }
    return json({ data: { ...totals, drilldownLinks, ...(guestPassMatches ? { guestPassMatches } : {}), eventCount: events.length, updatedAt: updatedAt?.toISOString() ?? null }, source: "guestbook-index", complete: true });
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
