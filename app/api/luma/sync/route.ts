import { normalizeEvent, normalizeGuest } from "../snapshot-normalization";
import { appendFile, mkdir } from "node:fs/promises";

type AnyRecord = Record<string, any>;
type HttpError = Error & { status?: number };
import nodePath from "node:path";
import { createSyncRun, finishSyncRun, getEventSyncStates, getIndexStats, hasLumaDb, recordEventSyncState, refreshIndexedEventOverviewStats, removeIndexedEventGuestsMissingFromSnapshot, runAutomaticTagClassifier, upsertNormalizedLumaSnapshot } from "../db";
import { lumaEventDate } from "../event-date";
import { requestedEventIds, shouldRefreshEventGuests } from "../sync-policy";
import { requireGuestbookKey } from "../../session-auth";
import {
  lumaApiKeys,
  lumaSessionTokens,
} from "../api-keys";
import { createLumaClient, sessionEventFromAdmin } from "../luma-client";

export const runtime = "nodejs";

const DEFAULT_DEBUG_LOG_PATH = nodePath.join(/*turbopackIgnore: true*/ process.cwd(), ".debug", "luma-api.log");
const SYNC_IN_FLIGHT_KEY = "__guestbookLumaSyncInFlight";
const lumaClient = createLumaClient({ logger: debugLog, beforeRequest: throttleSyncRequest, logPrefix: "sync " });
const fetchBounded = lumaClient.fetchBounded;
const fetchEventsAcrossCredentials = lumaClient.fetchEventsAcrossCredentials;
const fetchEventGuestsBounded = lumaClient.fetchEventGuestsBounded;
const lumaFetch = lumaClient.publicRequest;
const lumaPrivateGet = lumaClient.privateGet;
const resolveLumaEventReadCredential = lumaClient.resolveEventReadCredential;



export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("run") === "1") return runSync(request);

  const requestId = createRequestId();
  try {
    requireGuestbookKey(request);
    if (!hasLumaDb()) {
      return Response.json({ ok: false, error: "Missing DB_URL.", requestId }, { status: 503 });
    }
    const stats = await getIndexStats();
    return Response.json({ ok: true, requestId, stats });
  } catch (error) {
    await debugLog(requestId, "GET /api/luma/sync error", { status: error.status || 500, message: error.message }, "error");
    return jsonError(error, requestId);
  }
}

export async function POST(request: Request) {
  // Recovery/backfill only. Routine freshness uses the event catalog endpoint
  // plus selected-event count reconciliation.
  return runSync(request);
}

async function runSync(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  let syncRun = null;
  let eventCount = 0;
  let refreshedEventCount = 0;
  let skippedFreshEventCount = 0;
  let guestCount = 0;
  const people = new Set();
  let failedEventCount = 0;
  let credentialFailureCount = 0;
  let truncatedGuestEventCount = 0;
  let automaticTags = null;
  let syncLockAcquired = false;
  const overviewStatsEventIds: string[] = [];

  try {
    requireGuestbookKey(request);
    assertReadCredential();
    assertDb();

    const body = request.method === "POST" ? await readJsonBody(request) : {};
    const upcomingScope = body.scope === "upcoming" && Array.isArray(body.eventIds);
    requireSyncAuth(request, { allowSessionOnly: upcomingScope });
    const runningRequestId = globalThis[SYNC_IN_FLIGHT_KEY];
    if (runningRequestId) {
      await debugLog(requestId, "luma sync skipped already running", { scope: upcomingScope ? "upcoming" : "full" });
      return Response.json({ ok: true, status: "already_running", requestId, runningRequestId }, { status: 202 });
    }
    globalThis[SYNC_IN_FLIGHT_KEY] = requestId;
    syncLockAcquired = true;

    const limits = syncLimits(body);
    currentSyncRequestDelayMs = limits.requestDelayMs;
    const forceRefresh = shouldForceRefresh(request, body);
    await debugLog(requestId, "luma sync start", { limits, forceRefresh, scope: upcomingScope ? "upcoming" : "full", hasEventIds: Array.isArray(body.eventIds) && body.eventIds.length > 0 });

    let syncBody = body;
    let syncStates = new Map();
    if (upcomingScope && !forceRefresh) {
      const eventIds = requestedEventIds(body, limits.maxEvents);
      syncStates = await getEventSyncStates(eventIds);
      const staleEventIds = eventIds.filter((eventId) => shouldRefreshEventGuests({
        state: syncStates.get(eventId),
        forceRefresh: false,
        staleAfterMinutes: limits.staleAfterMinutes,
      }).refresh);
      skippedFreshEventCount = eventIds.length - staleEventIds.length;
      eventCount = skippedFreshEventCount;
      syncBody = { ...body, eventIds: staleEventIds };
      await debugLog(requestId, "luma sync upcoming freshness check", {
        requestedEventCount: eventIds.length,
        staleEventCount: staleEventIds.length,
        skippedFreshEventCount,
      });
      if (!staleEventIds.length) {
        automaticTags = await classifyAfterSync({ requestId, forceFull: false, personIds: [] });
        return Response.json({
          ok: true,
          status: "fresh",
          requestId,
          eventCount,
          refreshedEventCount: 0,
          skippedFreshEventCount,
          guestCount: 0,
          personCount: 0,
          failedEventCount: 0,
          truncated: false,
          limits,
          automaticTags,
        });
      }
    }

    syncRun = await createSyncRun({ requestId, limits });
    const rawEvents = await loadSyncEvents({ requestId, body: syncBody, limits });
    credentialFailureCount = rawEvents.credentialFailures?.length || 0;
    for (const failure of rawEvents.failures || []) {
      eventCount += 1;
      failedEventCount += 1;
      const missing = failure.status === 404;
      await recordEventSyncState({
        eventId: failure.eventId,
        guestCount: 0,
        status: missing ? "not_found" : "error",
        truncated: false,
        error: missing ? null : failure.message,
      }).catch(() => {});
      await debugLog(requestId, "luma sync event metadata skipped", {
        eventId: failure.eventId,
        status: failure.status,
        missing,
        message: failure.message,
      }, missing ? "info" : "error");
    }
    const managedEvents = rawEvents.entries
      .filter((event) => event.platform !== "external")
      .filter((event) => !upcomingScope || isUpcomingSyncEvent(event));
    if (!upcomingScope && !forceRefresh) syncStates = await getEventSyncStates(managedEvents.map((event) => event.id).filter(Boolean));

    for (const rawEvent of managedEvents) {
      const event = normalizeEvent(rawEvent);
      try {
        eventCount += 1;
        const syncDecision = shouldRefreshEventGuests({
          state: syncStates.get(event.id),
          forceRefresh,
          staleAfterMinutes: limits.staleAfterMinutes,
        });

        if (!syncDecision.refresh) {
          skippedFreshEventCount += 1;
          await debugLog(requestId, "luma sync event skipped fresh", { eventId: event.id, reason: syncDecision.reason, lastGuestSyncAt: syncDecision.lastGuestSyncAt });
          continue;
        }

        await debugLog(requestId, "luma sync event guests start", { eventId: event.id, maxGuestsPerEvent: limits.maxGuestsPerEvent });
        const rawGuests = await fetchEventGuestsBounded({
          requestId, eventId: event.id, pageSize: limits.guestPageSize,
          maxEntries: limits.maxGuestsPerEvent, maxPages: limits.maxGuestPagesPerEvent,
        });

        const guests = rawGuests.entries.map((guest) => normalizeGuest(rawEvent, guest));
        guests.forEach((guest) => {
          if (guest.personId) people.add(guest.personId);
        });
        if (rawGuests.truncated) truncatedGuestEventCount += 1;

        await upsertNormalizedLumaSnapshot({
          rawEvent,
          event,
          guests,
          rawGuests: rawGuests.entries,
        });
        if (!rawGuests.truncated) {
          const reconciliation = await removeIndexedEventGuestsMissingFromSnapshot({
            eventId: event.id,
            personIds: guests.map((guest) => guest.personId),
          });
          reconciliation.personIds.forEach((personId) => people.add(personId));
          overviewStatsEventIds.push(event.id);
        }
        await recordEventSyncState({
          eventId: event.id,
          guestCount: guests.length,
          status: rawGuests.truncated ? "truncated" : "success",
          truncated: rawGuests.truncated,
        });

        refreshedEventCount += 1;
        guestCount += guests.length;
        await debugLog(requestId, "luma sync event success", { eventId: event.id, guestCount: guests.length, truncated: rawGuests.truncated });
      } catch (error) {
        failedEventCount += 1;
        await recordEventSyncState({
          eventId: event.id,
          guestCount: 0,
          status: "error",
          truncated: false,
          error: error.message,
        }).catch(() => {});
        await debugLog(requestId, "luma sync event error", { eventId: event.id, status: error.status || 500, message: error.message }, "error");
      }
    }

    automaticTags = await classifyAfterSync({
      requestId,
      forceFull: !upcomingScope,
      personIds: [...people],
    });
    if (overviewStatsEventIds.length) await refreshIndexedEventOverviewStats(overviewStatsEventIds);
    const status = failedEventCount || credentialFailureCount ? "partial_error" : "success";
    const failureSummary = [
      failedEventCount ? `${failedEventCount} event(s) failed` : "",
      credentialFailureCount ? `${credentialFailureCount} credential(s) failed` : "",
    ].filter(Boolean).join("; ");
    if (syncRun) {
      await finishSyncRun(syncRun.id, {
        status,
        eventCount,
        guestCount,
        personCount: people.size,
        error: failureSummary ? `${failureSummary}. Check .debug/luma-api.log for requestId ${requestId}.` : null,
      });
    }

    const stats = await getIndexStats();
    await debugLog(requestId, "luma sync complete", {
      status,
      eventCount,
      refreshedEventCount,
      skippedFreshEventCount,
      guestCount,
      personCount: people.size,
      failedEventCount,
      credentialFailureCount,
      eventListTruncated: rawEvents.truncated,
      guestListsTruncated: truncatedGuestEventCount > 0,
      truncatedGuestEventCount,
      durationMs: Date.now() - startedAt,
    });

    return Response.json({
      ok: failedEventCount === 0 && credentialFailureCount === 0,
      status,
      requestId,
      eventCount,
      refreshedEventCount,
      skippedFreshEventCount,
      guestCount,
      personCount: people.size,
      failedEventCount,
      credentialFailureCount,
      truncated: rawEvents.truncated || truncatedGuestEventCount > 0,
      eventListTruncated: rawEvents.truncated,
      guestListsTruncated: truncatedGuestEventCount > 0,
      truncatedGuestEventCount,
      automaticTags,
      limits,
      stats,
    });
  } catch (error) {
    if (syncRun) {
      await finishSyncRun(syncRun.id, {
        status: "error",
        eventCount,
        guestCount,
        personCount: people.size,
        error: error.message,
      }).catch(() => {});
    }
    await debugLog(requestId, "luma sync error", { status: error.status || 500, message: error.message, durationMs: Date.now() - startedAt }, "error");
    return jsonError(error, requestId);
  } finally {
    if (syncLockAcquired && globalThis[SYNC_IN_FLIGHT_KEY] === requestId) delete globalThis[SYNC_IN_FLIGHT_KEY];
  }
}

async function classifyAfterSync({ requestId, forceFull, personIds }: AnyRecord) {
  const startedAt = Date.now();
  try {
    const result = await runAutomaticTagClassifier({ forceFull, personIds });
    if (result.changedCount) clearAutomaticTagGuestCaches();
    await debugLog(requestId, "auto-tags sync classification success", {
      mode: result.mode,
      evaluatedCount: result.evaluatedCount,
      matchedCount: result.matchedCount,
      addedCount: result.addedCount,
      removedCount: result.removedCount,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await debugLog(requestId, "auto-tags sync classification error", {
      status: error.status || 500,
      message: error.message,
      durationMs: Date.now() - startedAt,
    }, "error");
    return { ok: false, status: "error", error: error.message };
  }
}

function clearAutomaticTagGuestCaches() {
  const cache = (globalThis as typeof globalThis & { __guestbookLumaCache?: Map<string, unknown> }).__guestbookLumaCache;
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.startsWith("event-guests:") || key.startsWith("trace-person:")) cache.delete(key);
  }
}

async function loadSyncEvents({ requestId, body, limits }: AnyRecord) {
  if (Array.isArray(body.eventIds)) {
    const eventIds = requestedEventIds(body, limits.maxEvents);
    const entries = [];
    const failures = [];
    for (const eventId of eventIds) {
      try {
        const credential = await resolveLumaEventReadCredential(eventId, requestId);
        entries.push(credential.type === "api-key"
          ? await lumaFetch("/v1/events/get", {
              requestId,
              params: { event_id: eventId },
              apiKey: credential.value,
            })
          : sessionEventFromAdmin(await lumaPrivateGet({
              requestId,
              sessionToken: credential.value,
              path: "/event/admin/get",
              params: { event_api_id: eventId },
              operation: `event details (${credential.value.envName})`,
            })));
      } catch (error) {
        if (error.status !== 404) throw error;
        failures.push({
          eventId,
          status: error.status || 500,
          message: error.message,
        });
      }
    }
    return { entries, failures, credentialFailures: [], truncated: body.eventIds.length > eventIds.length };
  }

  return fetchEventsAcrossCredentials({
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
}

function syncLimits(body: AnyRecord = {}) {
  return {
    maxEvents: boundedBodyInt(body.maxEvents, "LUMA_SYNC_MAX_EVENTS", 250, 1, 5000),
    eventPageSize: boundedBodyInt(body.eventPageSize, "LUMA_SYNC_EVENTS_PAGE_SIZE", 50, 1, 50),
    maxEventPages: boundedBodyInt(body.maxEventPages, "LUMA_SYNC_MAX_EVENT_PAGES", 10, 1, 200),
    maxGuestsPerEvent: boundedBodyInt(body.maxGuestsPerEvent, "LUMA_SYNC_MAX_GUESTS_PER_EVENT", 1000, 1, 50000),
    guestPageSize: boundedBodyInt(body.guestPageSize, "LUMA_SYNC_GUESTS_PAGE_SIZE", 100, 1, 100),
    maxGuestPagesPerEvent: boundedBodyInt(body.maxGuestPagesPerEvent, "LUMA_SYNC_MAX_GUEST_PAGES_PER_EVENT", 10, 1, 1000),
    staleAfterMinutes: boundedBodyInt(body.staleAfterMinutes, "LUMA_SYNC_STALE_AFTER_MINUTES", 60, 0, 60 * 24 * 14),
    requestDelayMs: boundedBodyInt(body.requestDelayMs, "LUMA_SYNC_REQUEST_DELAY_MS", 350, 0, 5000),
  };
}

function shouldForceRefresh(request: Request, body: AnyRecord = {}) {
  const url = new URL(request.url);
  return body.force === true || body.refresh === true || url.searchParams.get("force") === "1" || url.searchParams.get("refresh") === "1";
}

function isUpcomingSyncEvent(event) {
  const eventDate = lumaEventDate(event);
  return Boolean(eventDate) && eventDate >= syncTodayKey();
}

function syncTodayKey() {
  const timeZone = process.env.LUMA_DEFAULT_TIMEZONE || "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

let lastSyncRequestAt = 0;
let currentSyncRequestDelayMs = 350;

async function throttleSyncRequest() {
  const delayMs = currentSyncRequestDelayMs;
  if (!delayMs) return;
  const elapsed = Date.now() - lastSyncRequestAt;
  if (elapsed < delayMs) await wait(delayMs - elapsed);
  lastSyncRequestAt = Date.now();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireSyncAuth(request, { allowSessionOnly = false } = {}) {
  if (allowSessionOnly) return;
  const secret = process.env.GUESTBOOK_SYNC_SECRET;
  if (!secret && process.env.NODE_ENV !== "production") return;
  if (!secret) {
    const error = new Error("Missing GUESTBOOK_SYNC_SECRET. Refusing to run sync without a secret in production.") as HttpError;
    error.status = 503;
    throw error;
  }

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const headerSecret = request.headers.get("x-guestbook-sync-secret") || "";
  const urlSecret = new URL(request.url).searchParams.get("secret") || "";
  if (bearer === secret || headerSecret === secret || urlSecret === secret) return;

  const error = new Error("Unauthorized sync request.") as HttpError;
  error.status = 401;
  throw error;
}

function assertReadCredential() {
  if (!lumaApiKeys().length && !lumaSessionTokens().length) {
    const error = new Error("Missing Luma credentials. Add LUMA_API_KEY, LUMA_SESSION_TOKEN, or a numbered variant before syncing live Luma data.") as HttpError;
    error.status = 503;
    throw error;
  }
}

function assertDb() {
  if (!hasLumaDb()) {
    const error = new Error("Missing DB_URL. Add a PostgreSQL connection string before syncing.") as HttpError;
    error.status = 503;
    throw error;
  }
}

async function readJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function boundedBodyInt(bodyValue: unknown, envName: string, fallback: number, min: number, max: number) {
  const raw = bodyValue ?? process.env[envName] ?? "";
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function createRequestId() {
  return "luma-sync-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
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
        if (lowered.includes("key") || lowered.includes("token") || lowered.includes("authorization") || lowered.includes("secret")) return [key, "[redacted]"];
        if (lowered.includes("email")) return [key, "[redacted-email]"];
        return [key, safeLogObject(nested)];
      }),
    );
  }
  return String(value);
}

function redactSecret(value) {
  return value.replace(/(x-luma-api-key|api[_-]?key|authorization|secret)([\s:=]+)([^\s,}]+)/gi, "$1$2[redacted]");
}

function truncateLogValue(value) {
  return value.length > 600 ? value.slice(0, 600) + "...[truncated]" : value;
}

function jsonError(error: any, requestId: string) {
  return Response.json(
    {
      ok: false,
      error: error.message,
      requestId,
    },
    { status: error.status || 500 },
  );
}
