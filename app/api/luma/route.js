import { appendFile, mkdir } from "node:fs/promises";
import nodePath from "node:path";
import { getIndexedTrace, hasLumaDb, listIndexedEventGuests, listIndexedEvents, removeIndexedEventGuestsMissingFromSnapshot, removeIndexedTraceRecordsMissingFromEvents, updateIndexedGuestStatus, upsertNormalizedLumaGuestActivity, upsertNormalizedLumaSnapshot } from "./db";
import { lumaEventDate } from "./event-date.mjs";
import { orderAvatarCandidates } from "../../avatar-order.mjs";

export const runtime = "nodejs";

const LUMA_BASE_URL = "https://public-api.luma.com";

const approvalToStatus = {
  approved: "going",
  pending_approval: "registered",
  invited: "invited",
  declined: "declined",
  waitlist: "waitlisted",
  session: "going",
};

const statusToApproval = {
  going: "approved",
  registered: "pending_approval",
  declined: "declined",
  waitlisted: "waitlist",
};

const LIVE_WRITE_CONFIRMATION = "CONFIRM_LUMA_WRITE";
const CACHE_KEY = "__guestbookLumaCache";
const IN_FLIGHT_KEY = "__guestbookLumaInFlight";
const DEFAULT_DEBUG_LOG_PATH = nodePath.join(process.cwd(), ".debug", "luma-api.log");

export async function GET(request) {
  const requestId = createRequestId();
  const startedAt = Date.now();

  try {
    assertApiKey();
    const url = new URL(request.url);
    const eventId = url.searchParams.get("event_id");
    const tracePersonId = url.searchParams.get("trace_person_id");
    const traceEmail = url.searchParams.get("trace_email") || url.searchParams.get("email");
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const refreshAll = url.searchParams.get("refresh_all") === "1";
    const traceScope = url.searchParams.get("trace_scope") === "all" ? "all" : "known";
    await debugLog(requestId, "GET /api/luma start", { eventId, tracePerson: Boolean(tracePersonId || traceEmail), forceRefresh, refreshAll, traceScope });

    if (tracePersonId || traceEmail) {
      if (!forceRefresh && hasLumaDb()) {
        try {
          const indexStartedAt = Date.now();
          const indexedTrace = await getIndexedTrace({
            tracePersonId,
            traceEmail,
            limit: safeInt("LUMA_INDEX_TRACE_MAX_RECORDS", 500, 1, 5000),
          });
          await debugLog(requestId, "trace person index hit", {
            recordCount: indexedTrace.records.length,
            durationMs: Date.now() - indexStartedAt,
          });
          return Response.json({ ...indexedTrace, requestId });
        } catch (error) {
          await debugLog(requestId, "trace person index skipped", { status: error.status || 500, message: error.message }, "error");
        }
      }

      const payload = await tracePersonActivity({
        requestId,
        tracePersonId,
        traceEmail,
        forceRefresh,
        traceScope,
        startedAt,
      });
      return Response.json({ ...payload, requestId });
    }

    if (eventId) {
      const cacheKey = "event-guests:" + eventId;
      const cached = forceRefresh ? null : readCache(cacheKey);
      if (cached) {
        await debugLog(requestId, "event guests cache hit", { eventId, guestCount: cached.guests?.length || 0, cacheExpiresAt: cached.cacheExpiresAt });
        return Response.json({ ...cached, requestId });
      }

      const pageSize = forceRefresh
        ? safeInt("LUMA_EVENT_SYNC_GUESTS_PAGE_SIZE", 100, 1, 100)
        : safeInt("LUMA_GUESTS_PAGE_SIZE", 100, 1, 100);
      const maxEntries = forceRefresh
        ? safeInt("LUMA_EVENT_SYNC_MAX_GUESTS", 50000, 1, 50000)
        : safeInt("LUMA_MAX_GUESTS_PER_EVENT", 250, 1, 1000);
      const maxPages = forceRefresh
        ? safeInt("LUMA_EVENT_SYNC_MAX_GUEST_PAGES", 1000, 1, 1000)
        : safeInt("LUMA_MAX_GUEST_PAGES_PER_EVENT", 3, 1, 10);

      if (!forceRefresh && hasLumaDb()) {
        try {
          const indexedGuests = await listIndexedEventGuests(eventId, { limit: maxEntries });
          if (indexedGuests.guests.length) {
            await debugLog(requestId, "event guests index hit", { eventId, guestCount: indexedGuests.guests.length });
            return Response.json({ ...indexedGuests, requestId });
          }
          await debugLog(requestId, "event guests index empty", { eventId });
        } catch (error) {
          await debugLog(requestId, "event guests index skipped", { eventId, status: error.status || 500, message: error.message }, "error");
        }
      }

      await debugLog(requestId, "event guests cache miss", { eventId, pageSize, maxEntries, maxPages, forceRefresh });

      const event = await lumaFetch("/v1/events/get", {
        requestId,
        params: { event_id: eventId },
      });
      const rawGuests = await fetchBounded("/v1/events/guests/list", {
        requestId,
        params: {
          event_id: eventId,
          pagination_limit: String(pageSize),
          sort_column: "registered_at",
          sort_direction: "desc nulls last",
        },
        maxEntries,
        maxPages,
        requestDelayMs: forceRefresh ? safeInt("LUMA_EVENT_SYNC_REQUEST_DELAY_MS", 200, 0, 5000) : 0,
      });
      const normalizedEvent = normalizeEvent(event);
      const eventGuests = rawGuests.entries.map((guest) => normalizeGuest(event, guest));
      const peopleById = new Map();
      eventGuests.forEach((guest) => {
        if (!peopleById.has(guest.person.id)) peopleById.set(guest.person.id, guest.person);
      });

      let payload = {
        source: "luma",
        eventId,
        event: normalizedEvent,
        guests: eventGuests.map(({ person, ...guest }) => guest),
        people: [...peopleById.values()],
        truncated: rawGuests.truncated,
        loadedAt: new Date().toISOString(),
      };
      await writeSnapshotToIndex({
        requestId,
        rawEvent: event,
        event: normalizedEvent,
        guests: eventGuests,
        rawGuests: rawGuests.entries,
      });
      if (hasLumaDb()) {
        try {
          const indexedGuests = await listIndexedEventGuests(eventId, { limit: maxEntries });
          const countsByPerson = new Map(indexedGuests.guests.map((guest) => [guest.personId, guest.eventCounts]));
          payload = {
            ...payload,
            guests: payload.guests.map((guest) => ({ ...guest, eventCounts: countsByPerson.get(guest.personId) || null })),
          };
        } catch (error) {
          await debugLog(requestId, "event guest counts skipped", { eventId, status: error.status || 500, message: error.message }, "error");
        }
      }
      if (forceRefresh) {
        cacheStore().delete("events");
        clearCachePrefix("trace-person:");
      }
      writeCache(cacheKey, payload, cacheTtlMs("LUMA_GUEST_CACHE_SECONDS", 600));
      await debugLog(requestId, "event guests success", {
        eventId,
        guestCount: payload.guests.length,
        peopleCount: payload.people.length,
        truncated: payload.truncated,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ...payload, cached: false, requestId });
    }

    const pageSize = refreshAll ? safeInt("LUMA_REFRESH_EVENTS_PAGE_SIZE", 50, 1, 50) : safeInt("LUMA_EVENTS_PAGE_SIZE", 25, 1, 50);
    const maxEntries = refreshAll ? safeInt("LUMA_REFRESH_MAX_EVENTS", 250, 1, 500) : safeInt("LUMA_MAX_EVENTS", 25, 1, 100);
    const maxPages = refreshAll ? safeInt("LUMA_REFRESH_MAX_EVENT_PAGES", 5, 1, 10) : safeInt("LUMA_MAX_EVENT_PAGES", 1, 1, 5);
    const indexedEventLimit = safeInt("LUMA_INDEX_MAX_EVENTS", 5000, 1, 50000);

    if (!forceRefresh && hasLumaDb() && url.searchParams.get("source") !== "live") {
      try {
        const indexedEvents = await listIndexedEvents({ limit: indexedEventLimit });
        if (indexedEvents.events.length) {
          await debugLog(requestId, "events index hit", { eventCount: indexedEvents.events.length, indexedEventLimit });
          return Response.json({ ...indexedEvents, requestId });
        }
        await debugLog(requestId, "events index empty", {});
      } catch (error) {
        await debugLog(requestId, "events index skipped", { status: error.status || 500, message: error.message }, "error");
      }
    }

    const cachedEvents = forceRefresh ? null : readCache("events");
    if (cachedEvents) {
      await debugLog(requestId, "events cache hit", { eventCount: cachedEvents.events?.length || 0, cacheExpiresAt: cachedEvents.cacheExpiresAt });
      return Response.json({ ...cachedEvents, requestId });
    }

    await debugLog(requestId, "events cache miss", { pageSize, maxEntries, maxPages, forceRefresh });

    const rawEvents = await fetchBounded("/v1/calendars/events/list", {
      requestId,
      params: {
        pagination_limit: String(pageSize),
        sort_column: "start_at",
        sort_direction: "desc",
        access: ["manage"],
      },
      maxEntries,
      maxPages,
    });

    const managedRawEvents = rawEvents.entries.filter((event) => event.platform !== "external");
    const events = managedRawEvents.map((event) => normalizeEvent(event));
    const refreshSummary = refreshAll ? await refreshManagedData({ requestId, rawEvents: managedRawEvents }) : null;

    const payload = {
      source: "luma",
      events,
      people: [],
      loadedAt: new Date().toISOString(),
      truncated: rawEvents.truncated || Boolean(refreshSummary?.truncatedGuestEventCount || refreshSummary?.failedEventCount),
      limits: {
        maxEvents: maxEntries,
        maxGuestsPerEvent: refreshAll ? safeInt("LUMA_REFRESH_MAX_GUESTS_PER_EVENT", 50000, 1, 50000) : safeInt("LUMA_MAX_GUESTS_PER_EVENT", 250, 1, 1000),
      },
      ...(refreshSummary ? { refreshSummary } : {}),
    };
    if (!refreshAll) {
      for (const rawEvent of managedRawEvents) {
        await writeSnapshotToIndex({
          requestId,
          rawEvent,
          event: normalizeEvent(rawEvent),
          guests: [],
          rawGuests: [],
        });
      }
    }
    writeCache("events", payload, cacheTtlMs("LUMA_EVENTS_CACHE_SECONDS", 300));
    await debugLog(requestId, refreshAll ? "foreground refresh success" : "events success", {
      eventCount: events.length,
      guestCount: refreshSummary?.guestCount || 0,
      failedEventCount: refreshSummary?.failedEventCount || 0,
      truncated: payload.truncated,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ ...payload, cached: false, requestId });
  } catch (error) {
    await debugLog(requestId, "GET /api/luma error", { status: error.status || 500, message: error.message, durationMs: Date.now() - startedAt }, "error");
    return jsonError(error, requestId);
  }
}
export async function POST(request) {
  const requestId = createRequestId();
  const startedAt = Date.now();

  try {
    assertApiKey();
    const body = await request.json();
    await debugLog(requestId, "POST /api/luma start", { action: body.action, eventId: body.eventId });
    requireLiveWriteConfirmation(body);

    if (body.action === "updateGuestStatus") {
      assertString(body.eventId, "eventId");
      assertString(body.guestId, "guestId");
      const status = statusToApproval[body.status];
      if (!status) {
        await debugLog(requestId, "guest status skipped", { eventId: body.eventId, guestId: body.guestId, requestedStatus: body.status });
        return Response.json({ ok: false, skipped: true, message: "Luma does not support setting " + body.status + " through this endpoint.", requestId });
      }

      await debugLog(requestId, "guest status update start", { eventId: body.eventId, guestId: body.guestId, requestedStatus: body.status, lumaStatus: status });
      await lumaFetch("/v1/events/guests/update-status", {
        requestId,
        method: "POST",
        body: {
          event_id: body.eventId,
          guest_id: body.guestId,
          status,
          send_email: body.sendEmail ?? false,
        },
      });
      if (hasLumaDb()) {
        try {
          const indexedUpdate = await updateIndexedGuestStatus({ eventId: body.eventId, lumaGuestId: body.guestId, status: body.status, lumaApprovalStatus: status });
          cacheStore().delete("event-guests:" + body.eventId);
          clearCachePrefix("trace-person:");
          await debugLog(requestId, "guest status index updated", { eventId: body.eventId, updatedCount: indexedUpdate.updatedCount });
        } catch (error) {
          await debugLog(requestId, "guest status index update skipped", { eventId: body.eventId, status: error.status || 500, message: error.message }, "error");
        }
      }
      await debugLog(requestId, "guest status update success", { eventId: body.eventId, guestId: body.guestId, durationMs: Date.now() - startedAt });
      return Response.json({ ok: true, requestId });
    }

    if (body.action === "sendInvites") {
      assertString(body.eventId, "eventId");
      const inviteLimit = safeInt("LUMA_MAX_INVITES_PER_REQUEST", 50, 1, 200);
      const guests = (body.guests || [])
        .filter((guest) => guest.source === "luma" && guest.email)
        .map((guest) => ({
          email: guest.email,
          name: guest.name || null,
        }));

      await debugLog(requestId, "send invites prepared", { eventId: body.eventId, requestedCount: body.guests?.length || 0, lumaRecipientCount: guests.length, inviteLimit });

      if (!guests.length) {
        return Response.json({ ok: false, error: "No Luma-origin recipients were provided.", requestId }, { status: 400 });
      }
      if (guests.length > inviteLimit) {
        return Response.json({ ok: false, error: "Refusing to invite " + guests.length + " people at once. Limit is " + inviteLimit + ".", requestId }, { status: 400 });
      }

      await lumaFetch("/v1/events/guests/send-invites", {
        requestId,
        method: "POST",
        body: {
          event_id: body.eventId,
          guests,
          message: body.message || null,
        },
      });
      await debugLog(requestId, "send invites success", { eventId: body.eventId, invited: guests.length, durationMs: Date.now() - startedAt });
      return Response.json({ ok: true, invited: guests.length, requestId });
    }

    await debugLog(requestId, "unsupported action", { action: body.action }, "error");
    return Response.json({ ok: false, error: "Unsupported action.", requestId }, { status: 400 });
  } catch (error) {
    await debugLog(requestId, "POST /api/luma error", { status: error.status || 500, message: error.message, durationMs: Date.now() - startedAt }, "error");
    return jsonError(error, requestId);
  }
}
function normalizeEvent(event) {
  return {
    id: event.id,
    title: event.name || "Untitled event",
    date: lumaEventDate(event),
    startsAt: event.start_at || null,
    location: formatLocation(event),
    category: firstTag(event) || event.calendar?.name || "Luma",
    capacity: event.max_capacity || event.guest_capacity || event.guest_count || 1,
    lumaUrl: event.url || "",
    imageUrl: extractEventImageUrl(event),
    description: firstString(event.description, event.description_md, event.event_description, event.summary),
    guests: [],
    guestsLoaded: false,
    source: "luma",
  };
}

function assertApiKey() {
  if (!process.env.LUMA_API_KEY) {
    const error = new Error("Missing LUMA_API_KEY. Add it to .env.local before using live Luma data.");
    error.status = 503;
    throw error;
  }
}

function requireLiveWriteConfirmation(body) {
  if (body.confirm !== LIVE_WRITE_CONFIRMATION) {
    const error = new Error("Live Luma write was blocked because the request did not include an explicit confirmation token.");
    error.status = 400;
    throw error;
  }
}

function assertString(value, name) {
  if (!value || typeof value !== "string") {
    const error = new Error("Missing required " + name + ".");
    error.status = 400;
    throw error;
  }
}

async function fetchBounded(path, { params = {}, maxEntries, maxPages, requestId, requestDelayMs = 0 }) {
  const entries = [];
  let cursor = null;
  let pages = 0;
  do {
    if (pages > 0 && requestDelayMs) await wait(requestDelayMs);
    await debugLog(requestId, "bounded fetch page start", { path, page: pages + 1, maxPages, maxEntries, hasCursor: Boolean(cursor) });
    const page = await lumaFetch(path, {
      requestId,
      params: {
        ...params,
        ...(cursor ? { pagination_cursor: cursor } : {}),
      },
    });
    pages += 1;
    entries.push(...(page.entries || []));
    cursor = page.next_cursor || null;
    await debugLog(requestId, "bounded fetch page success", { path, page: pages, pageEntries: page.entries?.length || 0, totalEntries: entries.length, hasMore: Boolean(cursor) });
  } while (cursor && entries.length < maxEntries && pages < maxPages);

  const truncated = Boolean(cursor || entries.length > maxEntries);
  await debugLog(requestId, "bounded fetch complete", { path, pages, entries: Math.min(entries.length, maxEntries), truncated });
  return {
    entries: entries.slice(0, maxEntries),
    truncated,
  };
}

async function lumaFetch(path, { method = "GET", params = {}, body, requestId, logParams = params, allowNotFound = false } = {}) {
  const url = new URL(path, LUMA_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const requestKey = method === "GET" ? method + " " + url.toString() : null;
  const startedAt = Date.now();
  const logDetails = { method, path, params: safeLogObject(logParams) };
  if (requestKey) {
    const pending = inFlightStore().get(requestKey);
    if (pending) {
      await debugLog(requestId, "luma fetch in-flight reuse", logDetails);
      return pending;
    }
  }

  await debugLog(requestId, "luma fetch start", logDetails);
  const request = fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-luma-api-key": process.env.LUMA_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  }).then(async (response) => {
    if (allowNotFound && response.status === 404) {
      await debugLog(requestId, "luma fetch not found", { ...logDetails, status: 404, durationMs: Date.now() - startedAt });
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      await debugLog(requestId, "luma fetch error", { ...logDetails, status: response.status, response: text, durationMs: Date.now() - startedAt }, "error");
      const error = new Error("Luma API " + response.status + ": " + (text || response.statusText));
      error.status = response.status;
      throw error;
    }

    await debugLog(requestId, "luma fetch success", { ...logDetails, status: response.status, durationMs: Date.now() - startedAt });
    if (response.status === 204) return {};
    return response.json();
  });

  if (!requestKey) return request;
  inFlightStore().set(requestKey, request);
  try {
    return await request;
  } finally {
    inFlightStore().delete(requestKey);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeInt(envName, fallback, min, max) {
  const value = Number.parseInt(process.env[envName] || "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function cacheTtlMs(envName, fallbackSeconds) {
  return safeInt(envName, fallbackSeconds, 30, 3600) * 1000;
}

function cacheStore() {
  if (!globalThis[CACHE_KEY]) globalThis[CACHE_KEY] = new Map();
  return globalThis[CACHE_KEY];
}

function inFlightStore() {
  if (!globalThis[IN_FLIGHT_KEY]) globalThis[IN_FLIGHT_KEY] = new Map();
  return globalThis[IN_FLIGHT_KEY];
}

function readCache(key) {
  const cache = cacheStore();
  const record = cache.get(key);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return {
    ...record.value,
    cached: true,
    cacheExpiresAt: new Date(record.expiresAt).toISOString(),
  };
}

function writeCache(key, value, ttlMs) {
  cacheStore().set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clearCachePrefix(prefix) {
  for (const key of cacheStore().keys()) {
    if (key.startsWith(prefix)) cacheStore().delete(key);
  }
}

async function refreshManagedData({ requestId, rawEvents }) {
  const limits = {
    maxGuestsPerEvent: safeInt("LUMA_REFRESH_MAX_GUESTS_PER_EVENT", 50000, 1, 50000),
    guestPageSize: safeInt("LUMA_REFRESH_GUESTS_PAGE_SIZE", 100, 1, 100),
    maxGuestPagesPerEvent: safeInt("LUMA_REFRESH_MAX_GUEST_PAGES_PER_EVENT", 1000, 1, 1000),
    requestDelayMs: safeInt("LUMA_REFRESH_REQUEST_DELAY_MS", 325, 0, 2000),
  };
  let guestCount = 0;
  let personCount = 0;
  let refreshedEventCount = 0;
  let failedEventCount = 0;
  let truncatedGuestEventCount = 0;
  let deletedStaleGuestCount = 0;

  await debugLog(requestId, "foreground refresh start", { eventCount: rawEvents.length, limits });
  for (let index = 0; index < rawEvents.length; index += 1) {
    const rawEvent = rawEvents[index];
    const event = normalizeEvent(rawEvent);
    if (index > 0 && limits.requestDelayMs) await wait(limits.requestDelayMs);
    try {
      const rawGuests = await fetchBounded("/v1/events/guests/list", {
        requestId,
        params: {
          event_id: event.id,
          pagination_limit: String(limits.guestPageSize),
          sort_column: "registered_at",
          sort_direction: "desc nulls last",
        },
        maxEntries: limits.maxGuestsPerEvent,
        maxPages: limits.maxGuestPagesPerEvent,
        requestDelayMs: limits.requestDelayMs,
      });
      const guests = rawGuests.entries.map((guest) => normalizeGuest(rawEvent, guest));
      const result = await writeSnapshotToIndex({ requestId, rawEvent, event, guests, rawGuests: rawGuests.entries });
      if (result && !rawGuests.truncated && hasLumaDb()) {
        const reconciliation = await removeIndexedEventGuestsMissingFromSnapshot({ eventId: event.id, personIds: guests.map((guest) => guest.personId) });
        deletedStaleGuestCount += reconciliation.deletedCount;
      }
      cacheStore().delete("event-guests:" + event.id);
      guestCount += guests.length;
      personCount += result?.personCount || 0;
      refreshedEventCount += 1;
      if (rawGuests.truncated) truncatedGuestEventCount += 1;
      await debugLog(requestId, "foreground refresh event success", { eventId: event.id, guestCount: guests.length, truncated: rawGuests.truncated });
    } catch (error) {
      failedEventCount += 1;
      await debugLog(requestId, "foreground refresh event error", { eventId: event.id, status: error.status || 500, message: error.message }, "error");
    }
  }

  clearCachePrefix("trace-person:");
  return { refreshedEventCount, failedEventCount, guestCount, personCount, truncatedGuestEventCount, deletedStaleGuestCount, limits };
}

async function tracePersonActivity({ requestId, tracePersonId, traceEmail, forceRefresh, traceScope, startedAt }) {
  const target = {
    id: normalizeTraceValue(tracePersonId),
    email: normalizeEmail(traceEmail),
  };

  if (!target.id && !target.email) {
    const error = new Error("Trace requires a Luma person id or email.");
    error.status = 400;
    throw error;
  }

  const cacheKey = "trace-person:" + (target.id || "no-id") + ":" + (target.email || "no-email");
  const cached = forceRefresh ? null : readCache(cacheKey);
  if (cached) {
    await debugLog(requestId, "trace person cache hit", {
      hasPersonId: Boolean(target.id),
      hasEmail: Boolean(target.email),
      recordCount: cached.records?.length || 0,
      cacheExpiresAt: cached.cacheExpiresAt,
    });
    return cached;
  }

  const limits = {
    maxEvents: safeInt("LUMA_TRACE_MAX_EVENTS", 250, 1, 500),
    eventPageSize: safeInt("LUMA_TRACE_EVENTS_PAGE_SIZE", 50, 1, 50),
    maxEventPages: safeInt("LUMA_TRACE_MAX_EVENT_PAGES", 5, 1, 10),
    requestDelayMs: safeInt("LUMA_TRACE_REQUEST_DELAY_MS", 325, 0, 2000),
  };
  const useKnownScope = traceScope !== "all" && hasLumaDb();
  await debugLog(requestId, "trace person cache miss", {
    hasPersonId: Boolean(target.id),
    hasEmail: Boolean(target.email),
    forceRefresh,
    traceScope: useKnownScope ? "known" : "all",
    limits,
  });

  let eventCandidates;
  let truncatedEvents = false;
  if (useKnownScope) {
    const indexedTrace = await getIndexedTrace({
      tracePersonId,
      traceEmail,
      limit: safeInt("LUMA_INDEX_TRACE_MAX_RECORDS", 500, 1, 5000),
    });
    const candidatesByEventId = new Map();
    indexedTrace.records.forEach((record) => {
      if (!candidatesByEventId.has(record.eventId)) candidatesByEventId.set(record.eventId, traceRecordToEventCandidate(record));
    });
    eventCandidates = [...candidatesByEventId.values()];
  } else {
    const rawEvents = await fetchBounded("/v1/calendars/events/list", {
      requestId,
      params: {
        pagination_limit: String(limits.eventPageSize),
        sort_column: "start_at",
        sort_direction: "desc",
        access: ["manage"],
      },
      maxEntries: limits.maxEvents,
      maxPages: limits.maxEventPages,
    });
    truncatedEvents = rawEvents.truncated;
    eventCandidates = rawEvents.entries.filter((event) => event.platform !== "external").map((rawEvent) => ({ rawEvent, event: normalizeEvent(rawEvent) }));
  }

  const records = [];
  const scannedEventIds = [];
  const matchedEventIds = [];
  let failedEventCount = 0;
  const lookupId = typeof traceEmail === "string" && traceEmail.trim() ? traceEmail.trim() : typeof tracePersonId === "string" ? tracePersonId.trim() : "";

  for (let index = 0; index < eventCandidates.length; index += 1) {
    const { rawEvent, event } = eventCandidates[index];
    if (!useKnownScope && index > 0 && limits.requestDelayMs) await wait(limits.requestDelayMs);
    try {
      const rawGuest = await lumaFetch("/v1/events/guests/get", {
        requestId,
        params: { event_id: event.id, id: lookupId },
        logParams: { event_id: event.id, id: "[redacted-person]" },
        allowNotFound: true,
      });
      scannedEventIds.push(event.id);
      if (!rawGuest) continue;
      const guest = normalizeGuest(rawEvent, rawGuest);
      if (!matchesTraceTarget(guest, target)) continue;
      matchedEventIds.push(event.id);
      records.push(normalizeTraceRecord(event, guest));
      if (useKnownScope) await upsertNormalizedLumaGuestActivity({ event, guest, rawGuest });
      else await writeSnapshotToIndex({ requestId, rawEvent, event, guests: [guest], rawGuests: [rawGuest] });
      cacheStore().delete("event-guests:" + event.id);
    } catch (error) {
      failedEventCount += 1;
      await debugLog(requestId, "trace direct lookup error", { eventId: event.id, status: error.status || 500, message: error.message }, "error");
    }
  }

  const reconciliation = hasLumaDb()
    ? await removeIndexedTraceRecordsMissingFromEvents({ tracePersonId, traceEmail, scannedEventIds, matchedEventIds })
    : { deletedCount: 0 };

  records.sort((a, b) => new Date(b.eventStartsAt || b.eventDate || b.sortAt) - new Date(a.eventStartsAt || a.eventDate || a.sortAt));

  const payload = {
    source: "luma",
    records,
    loadedAt: new Date().toISOString(),
    truncated: truncatedEvents || failedEventCount > 0,
    reconciled: true,
    traceScope: useKnownScope ? "known" : "all",
    scanned: {
      eventCount: scannedEventIds.length,
      guestCount: records.length,
      truncatedEvents,
      failedEventCount,
      deletedStaleRecordCount: reconciliation.deletedCount,
    },
    limits,
  };

  writeCache(cacheKey, payload, cacheTtlMs("LUMA_TRACE_CACHE_SECONDS", 900));
  await debugLog(requestId, "trace person success", {
    recordCount: records.length,
    scannedEventCount: scannedEventIds.length,
    directLookupCount: eventCandidates.length,
    traceScope: useKnownScope ? "known" : "all",
    truncatedEvents,
    failedEventCount,
    deletedStaleRecordCount: reconciliation.deletedCount,
    durationMs: Date.now() - startedAt,
  });
  return { ...payload, cached: false };
}

function traceRecordToEventCandidate(record) {
  const startsAt = record.eventStartsAt || (record.eventDate ? record.eventDate + "T00:00:00.000Z" : null);
  const event = {
    id: record.eventId,
    title: record.eventTitle || "Untitled event",
    date: record.eventDate || startsAt?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    startsAt,
    location: record.eventLocation || "Location TBD",
    category: record.eventCategory || "Luma",
    capacity: 1,
    lumaUrl: record.eventUrl || "",
    guests: [],
    guestsLoaded: false,
    source: "luma",
  };
  return {
    event,
    rawEvent: {
      id: event.id,
      name: event.title,
      start_at: event.startsAt,
      url: event.lumaUrl,
    },
  };
}

async function writeSnapshotToIndex({ requestId, rawEvent, event, guests, rawGuests }) {
  if (!hasLumaDb()) return null;
  try {
    const result = await upsertNormalizedLumaSnapshot({ rawEvent, event, guests, rawGuests });
    await debugLog(requestId, "luma index snapshot written", {
      eventId: event.id,
      eventCount: result.eventCount,
      guestCount: result.guestCount,
      personCount: result.personCount,
    });
    return result;
  } catch (error) {
    await debugLog(requestId, "luma index snapshot skipped", { eventId: event.id, status: error.status || 500, message: error.message }, "error");
    return null;
  }
}

function createRequestId() {
  return "luma-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function debugLogPath() {
  const configured = process.env.GUESTBOOK_DEBUG_LOG_PATH;
  if (!configured) return DEFAULT_DEBUG_LOG_PATH;
  return nodePath.isAbsolute(configured) ? configured : nodePath.join(/*turbopackIgnore: true*/ process.cwd(), configured);
}

async function debugLog(requestId, event, details = {}, level = "info") {
  const entry = {
    timestamp: new Date().toISOString(),
    requestId: requestId || "no-request",
    level,
    event,
    details: safeLogObject(details),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error("[luma-api]", line);
  else console.log("[luma-api]", line);

  try {
    const filePath = debugLogPath();
    await mkdir(nodePath.dirname(filePath), { recursive: true });
    await appendFile(filePath, line + "\n", "utf8");
  } catch (error) {
    console.error("[luma-api] failed to write debug log", error.message);
  }
}

function safeLogObject(value) {
  if (value == null) return value;
  if (typeof value === "string") return truncateLogValue(redactSecret(value));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(safeLogObject);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        const lowered = key.toLowerCase();
        if (lowered.includes("key") || lowered.includes("token") || lowered.includes("authorization") || lowered.includes("secret")) {
          return [key, "[redacted]"];
        }
        if (lowered.includes("email")) return [key, "[redacted-email]"];
        return [key, safeLogObject(nested)];
      }),
    );
  }
  return String(value);
}

function redactSecret(value) {
  return value.replace(/(x-luma-api-key|api[_-]?key|authorization)([\s:=]+)([^\s,}]+)/gi, "$1$2[redacted]");
}

function truncateLogValue(value) {
  return value.length > 600 ? value.slice(0, 600) + "...[truncated]" : value;
}

function normalizeGuest(event, guest) {
  const registrationAnswers = normalizeRegistrationAnswers(guest.registration_answers);
  const lumaUserId = firstString(guest.user_id, guest.user_api_id, guest.user?.id, guest.user?.user_id, guest.user?.api_id);
  const lumaGuestId = firstString(guest.id, guest.api_id, guest.guest_id, guest.guest_api_id);
  const personId = lumaUserId || firstString(guest.user_email, guest.email, guest.user?.email, lumaGuestId) || "guest-" + Math.random().toString(36).slice(2, 10);
  const isPast = event.start_at ? new Date(event.start_at) < new Date() : false;
  const checkedInAt = extractCheckedInAt(guest);
  const checkedIn = Boolean(checkedInAt);
  const profileDescription = extractProfileDescription(guest, registrationAnswers);
  const socialLinks = mergeSocialLinks(extractSocialLinks(guest), extractSocialLinksFromAnswers(registrationAnswers));
  const registrationSearchText = extractRegistrationAnswerText(registrationAnswers);
  const referrer = extractReferrer(guest);
  const avatarCandidates = extractAvatarCandidates(guest);
  const avatarUrl = avatarCandidates[0] || "";
  const profileUrl = extractProfileUrl(guest);
  const searchText = [profileDescription, registrationSearchText, socialLinks.map((link) => link.display).join(" "), referrerText(referrer)].filter(Boolean).join(" ");
  const status =
    checkedIn ? "checked_in" : isPast && guest.approval_status === "approved" ? "no_show" : approvalToStatus[guest.approval_status] || "registered";
  const title = extractGuestTitle(guest, registrationAnswers);
  const registeredAt = firstString(guest.registered_at, guest.joined_at, status === "invited" ? "" : guest.created_at);

  return {
    person: {
      id: personId,
      lumaUserId,
      name: firstString(guest.user_name, guest.name, guest.user?.name) || [guest.user_first_name, guest.user_last_name].filter(Boolean).join(" ") || firstString(guest.user_email, guest.email, guest.user?.email) || "Unnamed guest",
      email: firstString(guest.user_email, guest.email, guest.user?.email),
      title,
      profileDescription,
      bio: profileDescription,
      avatarUrl,
      avatarCandidates,
      profileUrl: profileUrl || lumaProfileUrl(lumaUserId),
      socialLinks,
      referrer,
      groups: [],
      notes: profileDescription,
      source: "luma",
    },
    personId,
    lumaGuestId,
    lumaApprovalStatus: guest.approval_status,
    profileDescription,
    avatarUrl,
    avatarCandidates,
    profileUrl: profileUrl || lumaProfileUrl(lumaUserId),
    socialLinks,
    referrer,
    registrationAnswers,
    searchText,
    source: "luma",
    status,
    registeredAt,
    invitedAt: firstString(guest.invited_at, guest.invite_sent_at, status === "invited" ? guest.created_at : ""),
    createdAt: firstString(guest.created_at),
    updatedAt: firstString(guest.updated_at),
    approvedAt: firstString(guest.approved_at),
    checkedInAt,
  };
}

function extractCheckedInAt(guest) {
  const ticketCheckIns = Array.isArray(guest.event_tickets) ? guest.event_tickets.map((ticket) => ticket?.checked_in_at) : [];
  const candidates = [guest.checked_in_at, guest.event_ticket?.checked_in_at, ...ticketCheckIns]
    .map((value) => firstString(value))
    .filter(Boolean);

  return candidates.reduce((earliest, candidate) => {
    if (!earliest) return candidate;
    const earliestTime = Date.parse(earliest);
    const candidateTime = Date.parse(candidate);
    if (!Number.isFinite(candidateTime)) return earliest;
    return !Number.isFinite(earliestTime) || candidateTime < earliestTime ? candidate : earliest;
  }, "");
}

function normalizeTraceRecord(event, guest) {
  return {
    eventId: event.id,
    eventTitle: event.title,
    eventDate: event.date,
    eventStartsAt: event.startsAt,
    eventCategory: event.category,
    eventLocation: event.location,
    eventUrl: event.lumaUrl,
    personId: guest.personId,
    lumaGuestId: guest.lumaGuestId,
    status: guest.status,
    lumaApprovalStatus: guest.lumaApprovalStatus,
    registeredAt: guest.registeredAt,
    invitedAt: guest.invitedAt,
    checkedInAt: guest.checkedInAt,
    approvedAt: guest.approvedAt,
    profileDescription: guest.profileDescription,
    registrationAnswers: guest.registrationAnswers,
    referrer: guest.referrer,
    sortAt: guest.checkedInAt || guest.registeredAt || event.startsAt || event.date,
  };
}

function matchesTraceTarget(guest, target) {
  const ids = [guest.personId, guest.person?.id, guest.person?.lumaUserId].map(normalizeTraceValue).filter(Boolean);
  const email = normalizeEmail(guest.person?.email);
  return Boolean((target.id && ids.includes(target.id)) || (target.email && email && email === target.email));
}

function normalizeRegistrationAnswers(answers = []) {
  return answers
    .map((answer, index) => {
      const label = firstString(answer.label, answer.question_label, answer.question_text, answer.question?.label, answer.question?.title, answer.question?.text, answer.question);
      const value = stringifyAnswerValue(answer.value ?? answer.answer ?? answer.response);
      return {
        id: firstString(answer.id, answer.question_id, answer.question?.id) || "answer-" + index,
        label: label || "Question",
        value,
        questionType: firstString(answer.question_type, answer.type, answer.question?.type),
      };
    })
    .filter((answer) => answer.label || answer.value);
}

function extractProfileDescription(guest, registrationAnswers = []) {
  const candidates = [
    guest.user_bio,
    guest.user_description,
    guest.profile_description,
    guest.profile?.description,
    guest.profile?.bio,
    guest.user?.description,
    guest.user?.bio,
    guest.user?.profile?.bio,
    guest.user?.profile?.description,
  ];
  const direct = candidates.find((value) => typeof value === "string" && value.trim());
  if (direct) return direct.trim();

  const answer = registrationAnswers.find((item) => {
    const label = String(item.label || "").toLowerCase();
    return label.includes("bio") || label.includes("about") || label.includes("description") || label.includes("profile");
  });
  return answer?.value || "";
}

function extractRegistrationAnswerText(answers = []) {
  return answers
    .map((answer) => [answer.label, stringifyAnswerValue(answer.value)].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" ");
}

function extractGuestTitle(guest, registrationAnswers = []) {
  const companyAnswer = registrationAnswers.find((answer) => answer.questionType === "company" || answer.label.toLowerCase().includes("company"));
  const rawCompanyAnswer = (guest.registration_answers || []).find((answer) => answer.question_type === "company" || String(answer.label || "").toLowerCase().includes("company"));
  const jobTitle = firstString(
    guest.user_title,
    guest.user?.title,
    guest.profile?.title,
    rawCompanyAnswer?.value?.job_title,
    rawCompanyAnswer?.value?.title,
    rawCompanyAnswer?.value?.role,
  );
  const company = firstString(
    guest.user_company,
    guest.user?.company,
    guest.profile?.company,
    rawCompanyAnswer?.value?.company_name,
    rawCompanyAnswer?.value?.company,
    rawCompanyAnswer?.value?.organization,
  );
  const title = [jobTitle, company].filter(Boolean).join(" at ");
  return title || companyAnswer?.value || "Luma guest";
}

function extractAvatarUrl(guest) {
  return extractAvatarCandidates(guest)[0] || "";
}

function extractAvatarCandidates(guest) {
  return orderAvatarCandidates(uniqueUrls(
    guest.user_avatar_url,
    guest.avatar_url,
    guest.profile_picture_url,
    guest.photo_url,
    guest.image_url,
    guest.user?.avatar_url,
    guest.user?.profile_picture_url,
    guest.user?.photo_url,
    guest.user?.image_url,
    guest.user?.avatar?.url,
    guest.profile?.avatar_url,
    guest.profile?.profile_picture_url,
    guest.profile?.photo_url,
    guest.profile?.image_url,
    guest.profile_picture?.url,
    guest.linkedin_avatar_url,
    guest.linkedin_photo_url,
    guest.linkedin_profile_picture_url,
    guest.user?.linkedin_avatar_url,
    guest.user?.linkedin_photo_url,
    guest.profile?.linkedin_avatar_url,
    guest.profile?.linkedin_photo_url,
    guest.twitter_profile_image_url,
    guest.twitter_avatar_url,
    guest.x_profile_image_url,
    guest.x_avatar_url,
    guest.user?.twitter_profile_image_url,
    guest.user?.twitter_avatar_url,
    guest.profile?.twitter_profile_image_url,
    guest.profile?.twitter_avatar_url,
  ));
}

function extractEventImageUrl(event) {
  return firstUrlLike(
    event.cover_url,
    event.cover_image_url,
    event.image_url,
    event.thumbnail_url,
    event.event_image_url,
    event.cover?.url,
    event.cover?.image_url,
    event.calendar?.avatar_url,
  );
}

function extractProfileUrl(guest) {
  return firstUrlLike(
    guest.user_url,
    guest.profile_url,
    guest.luma_profile_url,
    guest.user?.url,
    guest.user?.profile_url,
    guest.user?.luma_profile_url,
    guest.profile?.url,
  );
}

function lumaProfileUrl(lumaUserId) {
  return lumaUserId?.startsWith("usr-") ? `https://luma.com/user/${encodeURIComponent(lumaUserId)}` : "";
}

function extractReferrer(guest) {
  const referrer = guest.referrer || guest.referred_by || guest.referrer_user || guest.invited_by || guest.invited_by_user || {};
  const value = {
    name: firstString(referrer.name, referrer.user_name, referrer.full_name, guest.referrer_name, guest.referred_by_name, guest.invited_by_name),
    email: firstString(referrer.email, referrer.user_email, guest.referrer_email, guest.referred_by_email, guest.invited_by_email),
    url: firstUrlLike(referrer.url, referrer.profile_url, guest.referrer_url, guest.referral_url),
    source: firstString(guest.registration_source, guest.referral_source, guest.utm_source),
  };
  return Object.values(value).some(Boolean) ? value : null;
}

function extractSocialLinks(guest) {
  const containers = [guest, guest.user, guest.profile, guest.user?.profile].filter(Boolean);
  const configs = [
    { type: "website", label: "Website", keys: ["website", "website_url", "personal_website", "homepage_url"] },
    { type: "linkedin", label: "LinkedIn", keys: ["linkedin", "linkedin_url", "linkedin_handle", "linkedin_profile"] },
    { type: "x", label: "X", keys: ["twitter", "twitter_url", "twitter_handle", "x", "x_url", "x_handle"] },
    { type: "instagram", label: "Instagram", keys: ["instagram", "instagram_url", "instagram_handle"] },
    { type: "github", label: "GitHub", keys: ["github", "github_url", "github_handle"] },
    { type: "tiktok", label: "TikTok", keys: ["tiktok", "tiktok_url", "tiktok_handle"] },
    { type: "youtube", label: "YouTube", keys: ["youtube", "youtube_url", "youtube_handle"] },
  ];

  return configs
    .map((config) => {
      const raw = firstStringFromContainers(containers, config.keys);
      const url = normalizeSocialUrl(config.type, raw);
      if (!url) return null;
      return {
        type: config.type,
        label: config.label,
        url,
        display: displaySocialValue(config.type, raw, url),
      };
    })
    .filter(Boolean);
}

function extractSocialLinksFromAnswers(registrationAnswers = []) {
  return registrationAnswers
    .map((answer) => {
      const type = socialTypeForQuestion(answer.label);
      if (!type || !answer.value) return null;
      const url = normalizeSocialUrl(type, answer.value);
      if (!url) return null;
      return {
        type,
        label: socialLabel(type),
        url,
        display: displaySocialValue(type, answer.value, url),
      };
    })
    .filter(Boolean);
}

function socialTypeForQuestion(label = "") {
  const normalized = label.toLowerCase();
  if (normalized.includes("linkedin")) return "linkedin";
  if (normalized.includes("twitter") || /\bx\b/.test(normalized)) return "x";
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("github")) return "github";
  if (normalized.includes("tiktok")) return "tiktok";
  if (normalized.includes("youtube")) return "youtube";
  if (normalized.includes("website") || normalized.includes("portfolio") || normalized.includes("personal site")) return "website";
  return "";
}

function socialLabel(type) {
  return {
    website: "Website",
    linkedin: "LinkedIn",
    x: "X",
    instagram: "Instagram",
    github: "GitHub",
    tiktok: "TikTok",
    youtube: "YouTube",
  }[type];
}

function normalizeSocialUrl(type, rawValue) {
  const raw = stringifyLinkValue(rawValue);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const handle = raw.replace(/^@/, "").replace(/^\/+/, "").trim();
  if (!handle) return "";
  if (type === "website") return handle.includes(".") ? "https://" + handle : "";
  if (type === "linkedin") {
    const linkedinHandle = handle.replace(/^in\//i, "");
    return linkedinHandle.includes("linkedin.com") ? "https://" + linkedinHandle : "https://www.linkedin.com/in/" + encodeURIComponent(linkedinHandle);
  }
  if (type === "x") return handle.includes("twitter.com") || handle.includes("x.com") ? "https://" + handle : "https://x.com/" + encodeURIComponent(handle);
  if (type === "instagram") return handle.includes("instagram.com") ? "https://" + handle : "https://www.instagram.com/" + encodeURIComponent(handle);
  if (type === "github") return handle.includes("github.com") ? "https://" + handle : "https://github.com/" + encodeURIComponent(handle);
  if (type === "tiktok") return handle.includes("tiktok.com") ? "https://" + handle : "https://www.tiktok.com/@" + encodeURIComponent(handle);
  if (type === "youtube") return handle.includes("youtube.com") || handle.includes("youtu.be") ? "https://" + handle : "https://www.youtube.com/@" + encodeURIComponent(handle);
  return "";
}

function displaySocialValue(type, rawValue, url) {
  const raw = stringifyLinkValue(rawValue);
  if (type === "linkedin" && /^\/?in\//i.test(raw)) return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  if (raw && !/^https?:\/\//i.test(raw) && type !== "website") return raw.startsWith("@") ? raw : "@" + raw.replace(/^@/, "");
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function mergeSocialLinks(...groups) {
  const links = new Map();
  groups.flat().filter(Boolean).forEach((link) => {
    const key = link.type + ":" + link.url.toLowerCase();
    if (!links.has(key)) links.set(key, link);
  });
  return [...links.values()];
}

function firstStringFromContainers(containers, keys) {
  for (const container of containers) {
    for (const key of keys) {
      const value = stringifyLinkValue(container?.[key]);
      if (value) return value;
    }
  }
  return "";
}

function stringifyLinkValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") return firstString(value.url, value.href, value.handle, value.username, value.value);
  return String(value).trim();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstUrlLike(...values) {
  return values.map(stringifyLinkValue).find((value) => value && (/^https?:\/\//i.test(value) || value.includes("."))) || "";
}

function uniqueUrls(...values) {
  return [...new Set(values.map(stringifyLinkValue).filter((value) => /^https?:\/\//i.test(value)))];
}

function referrerText(referrer) {
  if (!referrer) return "";
  return [referrer.name, referrer.email, referrer.url, referrer.source].filter(Boolean).join(" ");
}

function normalizeTraceValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeEmail(value) {
  return normalizeTraceValue(value);
}

function stringifyAnswerValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(stringifyAnswerValue).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(stringifyAnswerValue).filter(Boolean).join(" ");
  return String(value);
}

function formatLocation(event) {
  if (event.geo_address_json?.full_address) return event.geo_address_json.full_address;
  if (event.geo_address_json?.address) return event.geo_address_json.address;
  if (event.geo_address_json?.city_state) return event.geo_address_json.city_state;
  if (event.meeting_url) return "Online";
  return event.location_type || "Location TBD";
}

function firstTag(event) {
  const tag = event.tags?.[0];
  return tag?.name || tag?.tag_name || tag || null;
}

function jsonError(error, requestId) {
  return Response.json(
    {
      ok: false,
      error: error.message,
      requestId,
    },
    { status: error.status || 500 },
  );
}
