import { randomUUID } from "node:crypto";
import { prisma, upsertNormalizedLumaSnapshot, recordEventSyncState, invalidateIndexedAudienceCaches } from "./db";
import { lumaApiKeys } from "./api-keys";
import { normalizeEvent, normalizeGuest } from "./snapshot-normalization";
import { acquireCioControl, releaseCioControl } from "./cio-sync";
import { requireCioProductionIdentity } from "./cio-projection";

type Any = Record<string, any>;
type Page = { entries: Any[]; next_cursor?: string | null; has_more?: boolean };
export function validatedLumaPage(payload: any, previousCursor?: string | null): Page {
  if (!payload || !Array.isArray(payload.entries)) throw new Error("invalid_luma_page");
  if (payload.next_cursor != null && typeof payload.next_cursor !== "string") throw new Error("invalid_luma_cursor");
  if (payload.has_more && !payload.next_cursor) throw new Error("missing_luma_cursor");
  if (payload.next_cursor && payload.next_cursor === previousCursor) throw new Error("repeated_luma_cursor");
  return payload;
}
export type SourceState = {
  catalogCursor?: string | null; events?: Any[]; catalogDone?: boolean;
  current?: { event: Any; cursor: string | null; startedAt: string } | null;
  lastCycleAt?: string; nextCycleAt?: string; lastError?: string | null;
  after?: string;
};
type Dependencies = {
  request: (path: string, params: Record<string,string>) => Promise<any>;
  savePage: (event: Any, guests: Any[], startedAt: string, complete: boolean) => Promise<void>;
};

// One upstream page per step. Persist the returned cursor only AFTER saving the
// page. A process crash replays a page safely, never skips part of an event.
export async function advanceLumaSource(state: SourceState, recent: boolean, deps: Dependencies, now = new Date()): Promise<SourceState> {
  if (state.nextCycleAt && new Date(state.nextCycleAt) > now) return state;
  const next: SourceState = { ...state, lastError: null, nextCycleAt: undefined };
  if (recent && !next.after) next.after = new Date(now.getTime() - 7*86400_000).toISOString();
  if (!next.current && next.events?.length) {
    const [event, ...rest] = next.events;
    next.events = rest; next.current = { event, cursor: null, startedAt: now.toISOString() };
  }
  if (next.current) {
    const current = next.current;
    const page = validatedLumaPage(await deps.request("/v1/events/guests/list", {
      event_id: current.event.id, pagination_limit: "100", sort_column: "created_at", sort_direction: "asc",
      ...(current.cursor ? { pagination_cursor: current.cursor } : {}),
    }), current.cursor);
    const guests = page.entries.map(entry => entry.guest || entry);
    // Never generate random identities for malformed API data.
    if (guests.some(g => !g.id || !(g.user_id || g.user_email))) throw new Error("invalid_luma_guest");
    await deps.savePage(current.event, guests, current.startedAt, !page.next_cursor);
    next.current = page.next_cursor ? { ...current, cursor: page.next_cursor } : null;
    return next;
  }
  if (next.catalogDone) return { lastCycleAt: now.toISOString(), nextCycleAt: new Date(now.getTime() + (recent ? 15*60_000 : 86400_000)).toISOString(), lastError: null };
  const page = validatedLumaPage(await deps.request("/v1/calendars/events/list", {
    pagination_limit: "50", sort_column: "start_at", sort_direction: "desc", access: "manage",
    ...(next.catalogCursor ? { pagination_cursor: next.catalogCursor } : {}),
    ...(recent ? { after: next.after! } : {}),
  }), next.catalogCursor);
  const events = page.entries.map(entry => entry.event || entry).filter(event => event.platform !== "external" && event.access !== "view");
  if (events.some(event => !event.id || typeof event.id !== "string")) throw new Error("invalid_luma_event");
  return { ...next, events, catalogCursor: page.next_cursor || null, catalogDone: !page.next_cursor };
}

// Completed absence belongs to CIO's projection, not Guestbook's historical
// records. Keep a monotonic cutoff and enqueue corrections in one transaction.
export async function completeCioSourceSnapshot(eventId: string, startedAt: string, db = prisma()) {
  await db.$transaction(async tx => {
    const controls: any[] = await tx.$queryRawUnsafe(`
      INSERT INTO cio_sync_control(id, data) VALUES($1, jsonb_build_object('completedBefore', $2::timestamptz))
      ON CONFLICT(id) DO UPDATE SET data = jsonb_build_object('completedBefore',
        greatest((cio_sync_control.data->>'completedBefore')::timestamptz, $2::timestamptz)), updated_at = now()
      RETURNING data`, `coverage:${eventId}`, startedAt);
    await tx.$queryRawUnsafe(`SELECT cio_mark_email(email)::text FROM (
      SELECT DISTINCT email_lower AS email FROM luma_event_guests
      WHERE event_id = $1 AND last_seen_at < $2::timestamptz AND email_lower IS NOT NULL
    ) missing`, eventId, controls[0].data.completedBefore);
  });
}

export async function reconcileLumaSources({ db, fetchImpl = fetch, budgetMs = 15_000 }: {
  db?: ReturnType<typeof prisma>; fetchImpl?: typeof fetch; budgetMs?: number;
} = {}) {
  if (process.env.CIO_SYNC_SOURCE_ENABLED !== "true") return { enabled: false, pages: 0 };
  // This job writes source data; previews are not an isolated database.
  requireCioProductionIdentity();
  db ||= prisma();
  const owner = randomUUID();
  if (!await acquireCioControl("source-worker", owner, db)) return { busy: true, pages: 0 };
  const deadline = Date.now() + Math.min(15_000, budgetMs);
  let pages = 0, failures = 0, attempts = 0;
  try {
    const keys = lumaApiKeys();
    if (!keys.length) throw new Error("luma_api_keys_required");
    // Round-robin durable per-calendar cursors; a bad credential does not erase
    // another calendar or falsely mark coverage complete.
    const lanes = keys.flatMap(key => [true,false].map(recent => ({ key, recent, id: `source:${recent ? "recent" : "history"}:${key.envName}` })));
    const controls = await db.cioSyncControl.findMany({ where: { id: { in: lanes.map(l => l.id) } } });
    lanes.sort((a,b) => (controls.find(c => c.id === a.id)?.updatedAt.getTime() || 0) - (controls.find(c => c.id === b.id)?.updatedAt.getTime() || 0));
    for (const lane of lanes) {
      if (Date.now() >= deadline || attempts >= 4) break;
      let state = (controls.find(c => c.id === lane.id)?.data || {}) as SourceState;
      if (state.nextCycleAt && new Date(state.nextCycleAt) > new Date()) continue;
      attempts++;
      try {
        state = await advanceLumaSource(state, lane.recent, {
          request: async (path, params) => {
            const url = new URL(path, "https://public-api.luma.com");
            for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
            const res = await fetchImpl(url, { headers: { "x-luma-api-key": lane.key.value }, redirect: "error", signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`luma_http_${res.status}`);
            return res.json();
          },
          savePage: async (rawEvent, rawGuests, startedAt, complete) => {
            const event = normalizeEvent(rawEvent);
            // Partial pages are useful positive evidence, never proof of absence.
            await upsertNormalizedLumaSnapshot({ rawEvent, event, guests: rawGuests.map(g => normalizeGuest(rawEvent,g)), rawGuests });
            if (complete) await completeCioSourceSnapshot(event.id, startedAt, db);
            const guestCount = await db.lumaEventGuest.count({ where: { eventId: event.id } });
            await recordEventSyncState({ eventId: event.id, guestCount, status: complete ? "success" : "cio_loading", truncated: !complete });
            invalidateIndexedAudienceCaches();
          },
        });
        pages++;
      } catch(error: any) {
        failures++;
        const code = /^(luma_http_\d+|invalid_luma_page|invalid_luma_cursor|missing_luma_cursor|repeated_luma_cursor|invalid_luma_guest|invalid_luma_event)$/.test(error.message) ? error.message : "source_sync_failed";
        state = { ...state, lastError: code, nextCycleAt: new Date(Date.now()+60_000).toISOString() };
      }
      await db.cioSyncControl.upsert({ where: { id: lane.id }, create: { id: lane.id, data: state as any }, update: { data: state as any, updatedAt: new Date() } });
    }
    return { enabled: true, pages, failures };
  } finally { await releaseCioControl("source-worker", owner, db); }
}
