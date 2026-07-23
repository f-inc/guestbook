import { appendFile, mkdir } from "node:fs/promises";
import { after } from "next/server";

type AnyRecord = Record<string, any>;
type HttpError = Error & { status?: number; code?: string };
import nodePath from "node:path";
import { archiveIndexedEventsMissingFromCatalog, getIndexedEventAnalytics, getIndexedLifetimeEventCounts, getIndexedMultiEventStats, getIndexedTrace, hasLumaDb, listIndexedAnalyticsRespondents, listIndexedAudienceInviteRecipients, listIndexedEventGuestMutationTargets, listIndexedEventGuests, listIndexedEvents, listIndexedGuestReferrerTargets, listIndexedMultiEventGuests, normalizeIndexedAudienceCriteria, recordEventSyncState, removeIndexedEventGuestsMissingFromSnapshot, removeIndexedTraceRecordsMissingFromEvents, runAutomaticTagClassifier, updateIndexedGuestCheckIn, updateIndexedGuestReferrers, updateIndexedGuestStatus, upsertNormalizedLumaEvents, upsertNormalizedLumaGuestActivity, upsertNormalizedLumaSnapshot } from "./db";
import { lumaEventDate } from "./event-date";
import { filterGuestPayload, guestQueryRequiresIndex, parseGuestListQuery } from "./guest-query";
import { orderAvatarCandidates } from "../../avatar-order";
import { normalizeGuestStatusNotification } from "../../guest-status-notification";
import { normalizeInviteMessage } from "../../invite-message";
import {
  EVENT_SWITCH_DIAGNOSTICS_ACTION,
  EVENT_SWITCH_DIAGNOSTICS_PARAM,
  EVENT_SWITCH_DIAGNOSTICS_PREFIX,
  normalizeClientEventSwitchDiagnostic,
  normalizeEventSwitchDiagnosticId,
  type EventSwitchDiagnosticReporter,
} from "../../event-switch-diagnostics";
import { requireSessionKey } from "../session-auth";
import { normalizeMultiEventIds } from "./multi-event-stats";
import { extractLumaReferrer } from "./referrer";
import { parseAnalyticsRespondentQuery } from "./analytics-respondents";
import { parseAllMatchingGuestQuery } from "./all-matching-guest-selection";
import { liveEventCountsFromLumaEvent } from "../../event-count-reconciliation";
import { rateLimitBackoffMs } from "./rate-limit-retry";

export const runtime = "nodejs";

const LUMA_BASE_URL = "https://public-api.luma.com";
const LUMA_PRIVATE_BASE_URL = "https://api.luma.com";

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
const EVENT_GUEST_SCAN_IN_FLIGHT_KEY = "__guestbookLumaEventGuestScanInFlight";
const DEFAULT_DEBUG_LOG_PATH = nodePath.join(process.cwd(), ".debug", "luma-api.log");

export async function GET(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();

  try {
    requireSessionKey(request);
    assertApiKey();
    const url = new URL(request.url);
    const eventId = url.searchParams.get("event_id");
    const tracePersonId = url.searchParams.get("trace_person_id");
    const traceEmail = url.searchParams.get("trace_email") || url.searchParams.get("email");
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const refreshAll = url.searchParams.get("refresh_all") === "1";
    const refreshEventsOnly = url.searchParams.get("refresh_events") === "1";
    const analyticsOnly = url.searchParams.get("event_analytics") === "1";
    const analyticsRespondentsOnly = url.searchParams.get("analytics_respondents") === "1";
    const guestHistoryOnly = url.searchParams.get("guest_history") === "1";
    const multiEventStatsOnly = url.searchParams.get("multi_event_stats") === "1";
    const multiEventGuestsOnly = url.searchParams.get("multi_event_guests") === "1";
    const liveEventCountsOnly = url.searchParams.get("live_event_counts") === "1";
    const traceScope = url.searchParams.get("trace_scope") === "all" ? "all" : "known";
    // EVENT_SWITCH_DIAGNOSTICS: this ID correlates the browser lifecycle with server and DB phases.
    const eventSwitchDiagnosticId = normalizeEventSwitchDiagnosticId(url.searchParams.get(EVENT_SWITCH_DIAGNOSTICS_PARAM));
    const knownEventBoundary = parseKnownEventBoundary(url.searchParams);
    await debugLog(requestId, "GET /api/luma start", {
      eventId,
      tracePerson: Boolean(tracePersonId || traceEmail),
      forceRefresh,
      refreshAll,
      refreshEventsOnly,
      traceScope,
      ...(eventSwitchDiagnosticId ? { eventSwitchDiagnosticId } : {}),
    });

    if (liveEventCountsOnly) {
      const eventIds = [...new Set(url.searchParams.getAll("event_id")
        .map((value) => value.trim())
        .filter((value) => /^[a-z0-9_-]{1,160}$/i.test(value)))]
        .slice(0, 50);
      if (!eventIds.length) {
        return Response.json({ error: "At least one event_id is required.", requestId }, { status: 400 });
      }
      const counts = await Promise.all(eventIds.map(async (requestedEventId) => {
        const event = await lumaFetch("/v1/events/get", {
          requestId,
          params: { event_id: requestedEventId },
        });
        return liveEventCountsFromLumaEvent(event);
      }));
      await debugLog(requestId, "live event counts success", {
        eventCount: counts.length,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ counts, requestId });
    }

    if (analyticsRespondentsOnly) {
      if (!hasLumaDb()) return Response.json({ error: "Analytics respondents require DB_URL.", requestId }, { status: 503 });
      const respondentQuery = parseAnalyticsRespondentQuery(url.searchParams);
      if (!respondentQuery.eventIds.length) {
        return Response.json({ error: "At least one event_id is required.", requestId }, { status: 400 });
      }
      if (!respondentQuery.question) {
        return Response.json({ error: "A question is required.", requestId }, { status: 400 });
      }
      const result = await listIndexedAnalyticsRespondents(respondentQuery);
      await debugLog(requestId, "analytics respondents index hit", {
        eventCount: respondentQuery.eventIds.length,
        answerFiltered: Boolean(respondentQuery.answer),
        respondentCount: result.respondents.length,
        total: result.pageInfo.total,
        cursor: respondentQuery.cursor,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ...result, requestId });
    }

    if (multiEventStatsOnly) {
      if (!hasLumaDb()) return Response.json({ error: "Multi-event statistics require DB_URL.", requestId }, { status: 503 });
      const eventIds = normalizeMultiEventIds(url.searchParams.getAll("event_id"));
      if (eventIds.length < 2) return Response.json({ error: "At least two event_id values are required.", requestId }, { status: 400 });
      const aggregate = await getIndexedMultiEventStats(eventIds);
      await debugLog(requestId, "multi-event unique stats index hit", {
        eventCount: aggregate?.stats.eventCount || 0,
        uniqueRegistered: aggregate?.stats.registered || 0,
        uniqueCheckedIn: aggregate?.stats.checkedIn || 0,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ...aggregate, requestId });
    }

    if (multiEventGuestsOnly) {
      if (!hasLumaDb()) return Response.json({ error: "Multi-event guest search requires DB_URL.", requestId }, { status: 503 });
      const eventIds = normalizeMultiEventIds(url.searchParams.getAll("event_id"));
      if (eventIds.length < 2) return Response.json({ error: "At least two event_id values are required.", requestId }, { status: 400 });
      const guestQuery = parseGuestListQuery(url.searchParams);
      const result = await listIndexedMultiEventGuests(eventIds, guestQuery);
      await debugLog(requestId, "multi-event guest index hit", {
        eventCount: eventIds.length,
        uniqueGuestCount: result?.people.length || 0,
        matchingRegistrations: result?.pageInfo.matchingRegistrations || 0,
        filter: guestQuery.filter,
        searchLength: guestQuery.search.length,
        cursor: guestQuery.cursor,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ...result, requestId });
    }

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

    if (eventId && guestHistoryOnly && hasLumaDb()) {
      const historyStartedAt = Date.now();
      const personIds = [...new Set(
        url.searchParams.getAll("person_id")
          .map((value) => value.trim())
          .filter((value) => /^[a-z0-9@._-]{1,160}$/i.test(value)),
      )].slice(0, 100);
      if (!personIds.length) return Response.json({ error: "At least one person_id is required.", requestId }, { status: 400 });
      const diagnostic = createEventSwitchDiagnosticCollector(eventSwitchDiagnosticId, "history.db");
      const history = await getIndexedLifetimeEventCounts(eventId, personIds, diagnostic.report);
      if (eventSwitchDiagnosticId) {
        await debugLog(requestId, `${EVENT_SWITCH_DIAGNOSTICS_PREFIX}.server_history`, {
          diagnosticId: eventSwitchDiagnosticId,
          eventId,
          phases: diagnostic.phases,
          durationMs: Date.now() - historyStartedAt,
        });
      }
      await debugLog(requestId, "event guest history index hit", {
        eventId,
        personCount: personIds.length,
        durationMs: Date.now() - historyStartedAt,
      });
      return Response.json({ ...history, requestId });
    }

    if (eventId && analyticsOnly && hasLumaDb()) {
      const analyticsStartedAt = Date.now();
      const diagnostic = createEventSwitchDiagnosticCollector(eventSwitchDiagnosticId, "analytics.db");
      const analytics = await getIndexedEventAnalytics(eventId, diagnostic.report, knownEventBoundary);
      if (!analytics) return Response.json({ error: "Event not found in the Luma index.", requestId }, { status: 404 });
      if (eventSwitchDiagnosticId) {
        await debugLog(requestId, `${EVENT_SWITCH_DIAGNOSTICS_PREFIX}.server_analytics`, {
          diagnosticId: eventSwitchDiagnosticId,
          eventId,
          phases: diagnostic.phases,
          durationMs: Date.now() - analyticsStartedAt,
        });
      }
      await debugLog(requestId, "event analytics index hit", {
        eventId,
        registrationCount: analytics.stats.registered,
        questionCount: analytics.analyticsQuestions.length,
        durationMs: Date.now() - analyticsStartedAt,
      });
      return Response.json({ ...analytics, requestId });
    }

    if (eventId) {
      const cacheKey = eventGuestCacheKey(eventId);
      const guestQuery = parseGuestListQuery(url.searchParams);
      const prioritizePage = url.searchParams.get("guest_mode") === "page";
      const requiresIndexedPage = guestQueryRequiresIndex(guestQuery);

      const pageSize = forceRefresh
        ? safeInt("LUMA_EVENT_SYNC_GUESTS_PAGE_SIZE", 100, 1, 100)
        : safeInt("LUMA_GUESTS_PAGE_SIZE", 100, 1, 100);
      const maxEntries = forceRefresh
        ? safeInt("LUMA_EVENT_SYNC_MAX_GUESTS", 50000, 1, 50000)
        : safeInt("LUMA_MAX_GUESTS_PER_EVENT", 250, 1, 1000);
      const maxPages = forceRefresh
        ? safeInt("LUMA_EVENT_SYNC_MAX_GUEST_PAGES", 1000, 1, 1000)
        : safeInt("LUMA_MAX_GUEST_PAGES_PER_EVENT", 3, 1, 10);

      // The To Decide view depends on the local operator-decision marker, which
      // is intentionally not present in Luma's remote guest payload cache.
      const cached = forceRefresh || guestQuery.filter === "to_decide" || requiresIndexedPage ? null : readCache(cacheKey);
      if (cached) {
        const filteredPayload = filterGuestPayload(cached, guestQuery);
        if (eventSwitchDiagnosticId) {
          await debugLog(requestId, `${EVENT_SWITCH_DIAGNOSTICS_PREFIX}.server_guest_cache`, {
            diagnosticId: eventSwitchDiagnosticId,
            eventId,
            guestCount: filteredPayload.guests.length,
            durationMs: Date.now() - startedAt,
          });
        }
        await debugLog(requestId, "event guests cache hit", {
          eventId,
          guestCount: filteredPayload.guests.length,
          filter: guestQuery.filter,
          searchLength: guestQuery.search.length,
          cacheExpiresAt: cached.cacheExpiresAt,
          durationMs: Date.now() - startedAt,
        });
        return Response.json({ ...filteredPayload, cached: true, snapshotReady: true, requestId });
      }

      if (!forceRefresh && hasLumaDb()) {
        try {
          const indexStartedAt = Date.now();
          const diagnostic = createEventSwitchDiagnosticCollector(eventSwitchDiagnosticId, prioritizePage || requiresIndexedPage ? "overview.db" : "snapshot.db");
          const indexedResult = prioritizePage || requiresIndexedPage
            ? await loadIndexedGuestPage(eventId, guestQuery, diagnostic.report, knownEventBoundary)
            : await loadIndexedGuestPayload(eventId, guestQuery, cacheKey, diagnostic.report, knownEventBoundary);
          if (indexedResult) {
            const { payload: indexedPayload, snapshotCached } = indexedResult;
            if (eventSwitchDiagnosticId) {
              await debugLog(requestId, `${EVENT_SWITCH_DIAGNOSTICS_PREFIX}.server_guests`, {
                diagnosticId: eventSwitchDiagnosticId,
                eventId,
                prioritizePage,
                phases: diagnostic.phases,
                durationMs: Date.now() - indexStartedAt,
              });
            }
            await debugLog(requestId, "event guests index hit", {
              eventId,
              guestCount: indexedPayload.guests.length,
              totalGuestCount: indexedPayload.stats?.total ?? null,
              filter: guestQuery.filter,
              searchLength: guestQuery.search.length,
              cursor: guestQuery.cursor,
              includeSummary: guestQuery.includeSummary !== false,
              prioritizePage,
              snapshotCached,
              durationMs: Date.now() - indexStartedAt,
            });
            return Response.json({ ...indexedPayload, snapshotReady: snapshotCached, requestId });
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
      const scan = () => fetchBounded("/v1/events/guests/list", {
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
      const rawGuests = forceRefresh
        ? await coalesceEventGuestScan(eventId, requestId, scan)
        : await scan();
      const normalizedEvent = normalizeEvent(event);
      const eventGuests = rawGuests.entries.map((guest) => normalizeGuest(event, guest));
      const peopleById = new Map();
      eventGuests.forEach((guest) => {
        if (!peopleById.has(guest.person.id)) peopleById.set(guest.person.id, guest.person);
      });

      const payload = {
        source: "luma",
        eventId,
        event: normalizedEvent,
        guests: eventGuests.map(({ person, ...guest }) => guest),
        people: [...peopleById.values()],
        truncated: rawGuests.truncated,
        loadedAt: new Date().toISOString(),
      };
      const indexWrite = await writeSnapshotToIndex({
        requestId,
        rawEvent: event,
        event: normalizedEvent,
        guests: eventGuests,
        rawGuests: rawGuests.entries,
      });
      let automaticTags = null;
      if (forceRefresh && indexWrite && hasLumaDb()) {
        await recordEventSyncState({
          eventId,
          guestCount: eventGuests.length,
          status: rawGuests.truncated ? "truncated" : "success",
          truncated: rawGuests.truncated,
        });
        if (!rawGuests.truncated) {
          const reconciliation = await removeIndexedEventGuestsMissingFromSnapshot({
            eventId,
            personIds: eventGuests.map((guest) => guest.personId),
          });
          automaticTags = await classifyAfterEventSync({
            requestId,
            eventId,
            personIds: [...eventGuests.map((guest) => guest.personId), ...reconciliation.personIds],
          });
        }
      }
      if (hasLumaDb()) {
        try {
          const indexedResult = await loadIndexedGuestPayload(eventId, guestQuery, cacheKey);
          if (!indexedResult) throw new Error("The refreshed event guest index is empty.");
          const { payload: indexedPayload } = indexedResult;
          if (forceRefresh) {
            cacheStore().delete("events");
            clearCachePrefix("trace-person:");
          }
          await debugLog(requestId, "event guests success", {
            eventId,
            guestCount: indexedPayload.guests.length,
            peopleCount: indexedPayload.people.length,
            truncated: rawGuests.truncated,
            durationMs: Date.now() - startedAt,
          });
          return Response.json({ ...indexedPayload, event: normalizedEvent, truncated: rawGuests.truncated, cached: false, snapshotReady: true, automaticTags, requestId });
        } catch (error) {
          await debugLog(requestId, "event guest counts skipped", { eventId, status: error.status || 500, message: error.message }, "error");
        }
      }
      if (forceRefresh) {
        cacheStore().delete("events");
        clearCachePrefix("trace-person:");
      }
      writeCache(cacheKey, payload, cacheTtlMs("LUMA_GUEST_CACHE_SECONDS", 600));
      const filteredPayload = filterGuestPayload(payload, guestQuery);
      await debugLog(requestId, "event guests success", {
        eventId,
        guestCount: filteredPayload.guests.length,
        peopleCount: filteredPayload.people.length,
        truncated: payload.truncated,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ...filteredPayload, cached: false, automaticTags, requestId });
    }

    const broadEventRefresh = refreshAll || refreshEventsOnly;
    const pageSize = broadEventRefresh ? safeInt("LUMA_REFRESH_EVENTS_PAGE_SIZE", 50, 1, 50) : safeInt("LUMA_EVENTS_PAGE_SIZE", 25, 1, 50);
    const maxEntries = refreshEventsOnly
      ? safeInt("LUMA_EVENT_CATALOG_MAX_EVENTS", 500, 1, 5000)
      : refreshAll
        ? safeInt("LUMA_REFRESH_MAX_EVENTS", 250, 1, 500)
        : safeInt("LUMA_MAX_EVENTS", 25, 1, 100);
    const maxPages = refreshEventsOnly
      ? safeInt("LUMA_EVENT_CATALOG_MAX_PAGES", 100, 1, 200)
      : refreshAll
        ? safeInt("LUMA_REFRESH_MAX_EVENT_PAGES", 5, 1, 10)
        : safeInt("LUMA_MAX_EVENT_PAGES", 1, 1, 5);
    const indexedEventLimit = safeInt("LUMA_INDEX_MAX_EVENTS", 5000, 1, 50000);

    if (!forceRefresh && !refreshEventsOnly && hasLumaDb() && url.searchParams.get("source") !== "live") {
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

    const cachedEvents = forceRefresh || refreshEventsOnly ? null : readCache("events");
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
    let catalogSummary = null;
    if (refreshEventsOnly && hasLumaDb()) {
      const snapshots = managedRawEvents.map((rawEvent, index) => ({ rawEvent, event: events[index] }));
      const indexed = await upsertNormalizedLumaEvents(snapshots);
      const archived = rawEvents.truncated
        ? { skipped: true, archivedEventCount: 0 }
        : await archiveIndexedEventsMissingFromCatalog(events.map((event) => event.id));
      catalogSummary = {
        indexedEventCount: indexed.eventCount,
        archivedEventCount: archived.archivedEventCount,
        deletionReconciliationSkipped: rawEvents.truncated,
      };
    }

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
      ...(catalogSummary ? { catalogSummary } : {}),
    };
    writeCache("events", payload, cacheTtlMs("LUMA_EVENTS_CACHE_SECONDS", 300));
    if (!refreshAll && !refreshEventsOnly && hasLumaDb() && managedRawEvents.length) {
      const snapshots = managedRawEvents.map((rawEvent, index) => ({ rawEvent, event: events[index] }));
      after(async () => {
        try {
          const result = await upsertNormalizedLumaEvents(snapshots);
          await debugLog(requestId, "luma event index batch written", { eventCount: result.eventCount });
        } catch (error) {
          await debugLog(
            requestId,
            "luma event index batch skipped",
            { eventCount: snapshots.length, status: error.status || 500, message: error.message },
            "error",
          );
        }
      });
    }
    await debugLog(requestId, refreshAll ? "foreground refresh success" : refreshEventsOnly ? "event catalog refresh success" : "events success", {
      eventCount: events.length,
      guestCount: refreshSummary?.guestCount || 0,
      failedEventCount: refreshSummary?.failedEventCount || 0,
      archivedEventCount: catalogSummary?.archivedEventCount || 0,
      truncated: payload.truncated,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ ...payload, cached: false, requestId });
  } catch (error) {
    await debugLog(requestId, "GET /api/luma error", { status: error.status || 500, message: error.message, durationMs: Date.now() - startedAt }, "error");
    return jsonError(error, requestId);
  }
}
export async function POST(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();

  try {
    requireSessionKey(request);
    const body: any = await request.json();
    // EVENT_SWITCH_DIAGNOSTICS: read-only client lifecycle ingest; deliberately bypasses Luma write confirmation.
    if (body.action === EVENT_SWITCH_DIAGNOSTICS_ACTION) {
      const diagnostic = normalizeClientEventSwitchDiagnostic(body);
      if (!diagnostic.diagnosticId) {
        return Response.json({ error: "Invalid event switch diagnostic ID.", requestId }, { status: 400 });
      }
      await debugLog(requestId, `${EVENT_SWITCH_DIAGNOSTICS_PREFIX}.client`, diagnostic);
      return Response.json({ ok: true, requestId });
    }

    if (body.action === "getGuestReferrer") {
      assertString(body.eventId, "eventId");
      assertString(body.personId, "personId");
      assertString(body.lumaUserId, "lumaUserId");
      const lumaSessionToken = normalizeLumaSessionToken(body.lumaSessionToken);
      await debugLog(requestId, "private guest referrer start", { eventId: body.eventId });
      const guestInfo = await lumaPrivateGet({
        requestId,
        lumaSessionToken,
        path: "/event/admin/get-guest-info",
        params: { event_api_id: body.eventId, user_api_id: body.lumaUserId },
        operation: "guest info",
      });
      const referrer = privateLumaReferrer(guestInfo);
      if (referrer && hasLumaDb()) {
        await updateIndexedGuestReferrers(body.eventId, [{ personId: body.personId, referrer }]);
        clearEventGuestCache(body.eventId);
      }
      await debugLog(requestId, "private guest referrer success", {
        eventId: body.eventId,
        found: Boolean(referrer),
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ok: true, eventId: body.eventId, personId: body.personId, referrer, requestId });
    }

    if (body.action === "syncGuestReferrers") {
      assertString(body.eventId, "eventId");
      if (!hasLumaDb()) {
        const error = new Error("Referrer sync requires DB_URL.") as HttpError;
        error.status = 503;
        throw error;
      }
      const lumaSessionToken = normalizeLumaSessionToken(body.lumaSessionToken);
      const maxGuests = safeInt("LUMA_REFERRER_SYNC_MAX_GUESTS", 250, 1, 500);
      const concurrency = safeInt("LUMA_REFERRER_SYNC_CONCURRENCY", 4, 1, 10);
      const requestDelayMs = safeInt("LUMA_REFERRER_SYNC_REQUEST_DELAY_MS", 100, 0, 5000);
      const targets = await listIndexedGuestReferrerTargets(body.eventId, maxGuests);
      const updates = [];
      let failedCount = 0;
      await debugLog(requestId, "private guest referrer sync start", {
        eventId: body.eventId,
        targetCount: targets.length,
        maxGuests,
        concurrency,
      });

      for (let index = 0; index < targets.length; index += concurrency) {
        if (index > 0 && requestDelayMs) await wait(requestDelayMs);
        const batch = targets.slice(index, index + concurrency);
        const results = await Promise.all(batch.map(async (target) => {
          try {
            const guestInfo = await lumaPrivateGet({
              requestId,
              lumaSessionToken,
              path: "/event/admin/get-guest-info",
              params: { event_api_id: body.eventId, user_api_id: target.lumaUserId },
              operation: "guest info",
            });
            return { target, referrer: privateLumaReferrer(guestInfo), error: null };
          } catch (error) {
            if (error.code === "LUMA_SESSION_INVALID") throw error;
            return { target, referrer: null, error };
          }
        }));
        results.forEach((result) => {
          if (result.error) failedCount += 1;
          else if (result.referrer) updates.push({ personId: result.target.personId, referrer: result.referrer });
        });
      }

      const indexed = await updateIndexedGuestReferrers(body.eventId, updates);
      if (indexed.updatedCount) {
        clearEventGuestCache(body.eventId);
        clearCachePrefix("trace-person:");
      }
      await debugLog(requestId, "private guest referrer sync success", {
        eventId: body.eventId,
        targetCount: targets.length,
        foundCount: updates.length,
        updatedCount: indexed.updatedCount,
        failedCount,
        truncated: targets.length >= maxGuests,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({
        ok: true,
        eventId: body.eventId,
        scanned: targets.length,
        found: updates.length,
        updated: indexed.updatedCount,
        failed: failedCount,
        truncated: targets.length >= maxGuests,
        requestId,
      });
    }

    if (body.action !== "updateGuestCheckIn") assertApiKey();
    await debugLog(requestId, "POST /api/luma start", { action: body.action, eventId: body.eventId });
    requireLiveWriteConfirmation(body);

    if (body.action === "updateGuestCheckIn") {
      assertString(body.eventId, "eventId");
      assertString(body.guestId, "guestId");
      if (typeof body.checkedIn !== "boolean") {
        const error = new Error("Missing required checkedIn state.") as HttpError;
        error.status = 400;
        throw error;
      }
      const lumaSessionToken = normalizeLumaSessionToken(body.lumaSessionToken);
      await debugLog(requestId, "private guest check-in start", {
        eventId: body.eventId,
        guestId: body.guestId,
        checkedIn: body.checkedIn,
      });
      await lumaPrivateCheckInFetch({
        requestId,
        lumaSessionToken,
        body: {
          event_api_id: body.eventId,
          rsvp_api_id: body.guestId,
          type: "guest",
          check_in_method: "guest-list",
          check_in_status: body.checkedIn ? "checked-in" : "not-checked-in",
        },
      });
      if (hasLumaDb()) {
        try {
          const indexedUpdate = await updateIndexedGuestCheckIn({
            eventId: body.eventId,
            lumaGuestId: body.guestId,
            checkedIn: body.checkedIn,
          });
          await debugLog(requestId, "private guest check-in index updated", {
            eventId: body.eventId,
            checkedIn: body.checkedIn,
            updatedCount: indexedUpdate.updatedCount,
          });
        } catch (error) {
          await debugLog(requestId, "private guest check-in index update skipped", {
            eventId: body.eventId,
            status: error.status || 500,
            message: error.message,
          }, "error");
        }
      }
      clearEventGuestCache(body.eventId);
      clearCachePrefix("trace-person:");
      await debugLog(requestId, "private guest check-in success", {
        eventId: body.eventId,
        guestId: body.guestId,
        checkedIn: body.checkedIn,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ok: true, checkedIn: body.checkedIn, requestId });
    }

    if (body.action === "updateGuestStatus") {
      assertString(body.eventId, "eventId");
      assertString(body.guestId, "guestId");
      const status = statusToApproval[body.status];
      if (!status) {
        await debugLog(requestId, "guest status skipped", { eventId: body.eventId, guestId: body.guestId, requestedStatus: body.status });
        return Response.json({ ok: false, skipped: true, message: "Luma does not support setting " + body.status + " through this endpoint.", requestId });
      }

      const notification = normalizeGuestStatusNotification({ sendEmail: body.sendEmail, message: body.message });

      await debugLog(requestId, "guest status update start", {
        eventId: body.eventId,
        guestId: body.guestId,
        requestedStatus: body.status,
        lumaStatus: status,
        sendEmail: notification.sendEmail,
        hasMessage: Boolean(notification.message),
      });
      await lumaFetch("/v1/events/guests/update-status", {
        requestId,
        method: "POST",
        body: {
          event_id: body.eventId,
          guest_id: body.guestId,
          status,
          send_email: notification.sendEmail,
          message: notification.message,
        },
      });
      if (hasLumaDb()) {
        try {
          const indexedUpdate = await updateIndexedGuestStatus({ eventId: body.eventId, lumaGuestId: body.guestId, status: body.status, lumaApprovalStatus: status });
          clearEventGuestCache(body.eventId);
          clearCachePrefix("trace-person:");
          await debugLog(requestId, "guest status index updated", { eventId: body.eventId, updatedCount: indexedUpdate.updatedCount });
        } catch (error) {
          await debugLog(requestId, "guest status index update skipped", { eventId: body.eventId, status: error.status || 500, message: error.message }, "error");
        }
      }
      await debugLog(requestId, "guest status update success", { eventId: body.eventId, guestId: body.guestId, durationMs: Date.now() - startedAt });
      return Response.json({ ok: true, notificationSent: notification.sendEmail, requestId });
    }

    if (body.action === "bulkUpdateGuestStatus") {
      assertString(body.eventId, "eventId");
      const lumaStatus = statusToApproval[body.status];
      if (!lumaStatus || !["going", "waitlisted", "declined"].includes(body.status)) {
        return Response.json({ ok: false, error: "Bulk status must be going, waitlisted, or declined.", requestId }, { status: 400 });
      }

      const allMatching = body.allMatching === true;
      const updateLimit = allMatching
        ? safeInt("LUMA_MAX_ALL_MATCHING_STATUS_UPDATES", 1000, 1, 5000)
        : safeInt("LUMA_MAX_BULK_STATUS_UPDATES", 50, 1, 200);
      let guestIds: string[];
      if (allMatching) {
        if (!hasLumaDb()) {
          return Response.json({ ok: false, error: "All-matching status updates require DB_URL.", requestId }, { status: 503 });
        }
        const query = parseAllMatchingGuestQuery(body);
        const targets = await listIndexedEventGuestMutationTargets(body.eventId, query, { limit: updateLimit + 1 });
        if (targets.length > updateLimit) {
          return Response.json({ ok: false, error: `Refusing to update more than ${updateLimit} matching guests at once.`, requestId }, { status: 400 });
        }
        const matchingGuestIds: string[] = targets.flatMap((target) => target.lumaGuestId ? [target.lumaGuestId] : []);
        guestIds = [...new Set<string>(matchingGuestIds)];
      } else {
        guestIds = [...new Set<string>(
          (Array.isArray(body.guests) ? body.guests : [])
            .map((guest): string => firstString(guest?.lumaGuestId, guest?.guestId))
            .filter(Boolean),
        )];
      }
      if (!guestIds.length) {
        return Response.json({ ok: false, error: "Select at least one Luma guest.", requestId }, { status: 400 });
      }
      if (guestIds.length > updateLimit) {
        return Response.json({ ok: false, error: `Refusing to update ${guestIds.length} guests at once. Limit is ${updateLimit}.`, requestId }, { status: 400 });
      }

      const notification = normalizeGuestStatusNotification({ sendEmail: body.sendEmail, message: body.message });
      const requestDelayMs = safeInt("LUMA_BULK_STATUS_REQUEST_DELAY_MS", 100, 0, 5000);
      const updatedGuestIds = [];
      const failures = [];
      await debugLog(requestId, "bulk guest status start", {
        eventId: body.eventId,
        requestedStatus: body.status,
        guestCount: guestIds.length,
        allMatching,
        sendEmail: notification.sendEmail,
        hasMessage: Boolean(notification.message),
      });

      for (let index = 0; index < guestIds.length; index += 1) {
        if (index > 0 && requestDelayMs) await wait(requestDelayMs);
        const guestId = guestIds[index];
        try {
          await lumaFetch("/v1/events/guests/update-status", {
            requestId,
            method: "POST",
            body: {
              event_id: body.eventId,
              guest_id: guestId,
              status: lumaStatus,
              send_email: notification.sendEmail,
              message: notification.message,
            },
          });
          updatedGuestIds.push(guestId);
          if (hasLumaDb()) {
            try {
              await updateIndexedGuestStatus({ eventId: body.eventId, lumaGuestId: guestId, status: body.status, lumaApprovalStatus: lumaStatus });
            } catch (error) {
              await debugLog(requestId, "bulk guest status index update skipped", { eventId: body.eventId, status: error.status || 500, message: error.message }, "error");
            }
          }
        } catch (error) {
          failures.push({ guestId, error: error.message || "Luma update failed." });
        }
      }

      clearEventGuestCache(body.eventId);
      clearCachePrefix("trace-person:");
      await debugLog(requestId, "bulk guest status complete", {
        eventId: body.eventId,
        requestedStatus: body.status,
        updatedCount: updatedGuestIds.length,
        failedCount: failures.length,
        durationMs: Date.now() - startedAt,
      }, failures.length ? "error" : "info");
      return Response.json(
        {
          ok: failures.length === 0,
          updated: updatedGuestIds.length,
          failed: failures.length,
          updatedGuestIds,
          failures,
          notificationSent: notification.sendEmail,
          requestId,
        },
        { status: failures.length ? 207 : 200 },
      );
    }

    if (body.action === "reinviteGuest") {
      assertString(body.eventId, "eventId");
      assertString(body.guestId, "guestId");
      assertString(body.lumaUserId, "lumaUserId");
      assertString(body.email, "email");
      const lumaSessionToken = normalizeLumaSessionToken(body.lumaSessionToken);
      const message = normalizeInviteMessage(body.message);
      await debugLog(requestId, "reinvite guest start", {
        eventId: body.eventId,
        guestId: body.guestId,
        hasMessage: Boolean(message),
      });

      const emailIssue = await lumaPrivateGet({
        requestId,
        lumaSessionToken,
        path: "/email/has-issue",
        params: { email: body.email },
        operation: "email issue check",
      });
      if (emailIssue === true || emailIssue?.has_issue === true || emailIssue?.bounced_at || emailIssue?.marked_as_spam_at) {
        const error = new Error("Luma has this email marked inactive, bounced, or reported as spam.") as HttpError;
        error.status = 409;
        error.code = "LUMA_EMAIL_INACTIVE";
        throw error;
      }

      const timelineBefore = await lumaPrivateGet({
        requestId,
        lumaSessionToken,
        path: "/event/admin/get-guest-timeline",
        params: { event_api_id: body.eventId, user_api_id: body.lumaUserId },
        operation: "guest timeline",
      });
      const previousTimelineIds = new Set(lumaTimelineEntries(timelineBefore).map(lumaTimelineEntryId));

      const inviteTask = await lumaPrivatePost({
        requestId,
        lumaSessionToken,
        path: "/event/admin/invite/send",
        body: {
          event_api_id: body.eventId,
          message,
          people: [{ type: "email", email: body.email, name: body.name || undefined }],
        },
        operation: "send guest invite",
      });
      await waitForLumaTask({ requestId, lumaSessionToken, taskId: inviteTask?.task_id });

      let emailEntry = null;
      let remoteGuest = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (attempt > 0) await wait(750);
        if (!emailEntry) {
          const timelineAfter = await lumaPrivateGet({
            requestId,
            lumaSessionToken,
            path: "/event/admin/get-guest-timeline",
            params: { event_api_id: body.eventId, user_api_id: body.lumaUserId },
            operation: "guest timeline",
          });
          emailEntry = lumaTimelineEntries(timelineAfter).find((entry) =>
            entry?.type === "email-sent" && !previousTimelineIds.has(lumaTimelineEntryId(entry)),
          ) || null;
        }
        remoteGuest = await lumaFetch("/v1/events/guests/get", {
          requestId,
          params: { event_id: body.eventId, id: body.guestId },
          logParams: { event_id: body.eventId, id: "[redacted-guest]" },
          allowNotFound: true,
        });
        if (emailEntry && remoteGuest?.approval_status === "invited") break;
      }

      if (!emailEntry) {
        const error = new Error("Luma accepted the request but did not record a sent email. The guest was left unchanged.") as HttpError;
        error.status = 502;
        error.code = "LUMA_INVITE_EMAIL_UNCONFIRMED";
        throw error;
      }
      if (remoteGuest?.approval_status !== "invited") {
        const error = new Error("Luma sent the email but did not change this guest to Invited. Guestbook left the status unchanged.") as HttpError;
        error.status = 502;
        error.code = "LUMA_INVITE_STATUS_UNCONFIRMED";
        throw error;
      }

      const email = emailEntry.email || {};
      const emailStatus = firstString(email.status);
      if (email.bounced_at || email.marked_as_spam_at || ["bounced", "marked-spam"].includes(emailStatus)) {
        const error = new Error(email.bounced_at || emailStatus === "bounced"
          ? "Luma recorded the reinvite email as bounced."
          : "Luma recorded the reinvite email as spam.") as HttpError;
        error.status = 502;
        error.code = "LUMA_INVITE_EMAIL_FAILED";
        throw error;
      }

      const emailSentAt = firstString(email.sent_at, email.delivered_at, emailEntry.timestamp) || new Date().toISOString();
      if (hasLumaDb()) {
        try {
          await updateIndexedGuestStatus({
            eventId: body.eventId,
            lumaGuestId: body.guestId,
            status: "invited",
            lumaApprovalStatus: "invited",
          });
        } catch (error) {
          await debugLog(requestId, "reinvite guest index update skipped", {
            eventId: body.eventId,
            status: error.status || 500,
            message: error.message,
          }, "error");
        }
      }
      clearEventGuestCache(body.eventId);
      clearCachePrefix("trace-person:");
      await debugLog(requestId, "reinvite email confirmed", {
        eventId: body.eventId,
        guestId: body.guestId,
        emailStatus: emailStatus || "sent",
        durationMs: Date.now() - startedAt,
      });
      return Response.json({
        ok: true,
        emailConfirmed: true,
        emailStatus: emailStatus || "sent",
        emailSentAt,
        requestId,
      });
    }

    if (body.action === "sendAudienceInvites") {
      if (!hasLumaDb()) {
        return Response.json({ ok: false, error: "Audience invitations require DB_URL.", requestId }, { status: 503 });
      }
      const eventIds = [...new Set((Array.isArray(body.eventIds) ? body.eventIds : [])
        .map((eventId) => String(eventId || "").trim())
        .filter(Boolean))].slice(0, 100);
      if (!eventIds.length) {
        return Response.json({ ok: false, error: "At least one event is required.", requestId }, { status: 400 });
      }
      const message = normalizeInviteMessage(body.message);
      const criteria = normalizeIndexedAudienceCriteria({
        ...(body.criteria || {}),
        excludeExistingEventIds: eventIds,
      });
      const recipients = await listIndexedAudienceInviteRecipients(criteria);
      if (!recipients.length) {
        return Response.json({ ok: false, error: "The selected audience has no emailable recipients.", requestId }, { status: 400 });
      }
      const inviteLimit = safeInt("LUMA_MAX_INVITES_PER_REQUEST", 50, 1, 200);
      await debugLog(requestId, "send audience invites prepared", {
        eventCount: eventIds.length,
        recipientCount: recipients.length,
        inviteLimit,
        hasMessage: Boolean(message),
      });
      for (const eventId of eventIds) {
        for (let index = 0; index < recipients.length; index += inviteLimit) {
          const guests = recipients.slice(index, index + inviteLimit).map(({ email, name }) => ({ email, name: name || null }));
          await lumaFetch("/v1/events/guests/send-invites", {
            requestId,
            method: "POST",
            body: { event_id: eventId, guests, message },
          });
        }
      }
      const invited = recipients.length * eventIds.length;
      await debugLog(requestId, "send audience invites success", {
        eventCount: eventIds.length,
        recipientCount: recipients.length,
        invited,
        durationMs: Date.now() - startedAt,
      });
      return Response.json({ ok: true, recipients: recipients.length, invited, requestId });
    }

    if (body.action === "sendInvites") {
      assertString(body.eventId, "eventId");
      const inviteLimit = safeInt("LUMA_MAX_INVITES_PER_REQUEST", 50, 1, 200);
      const message = normalizeInviteMessage(body.message);
      const guests = (body.guests || [])
        .filter((guest) => guest.source === "luma" && guest.email)
        .map((guest) => ({
          email: guest.email,
          name: guest.name || null,
        }));

      await debugLog(requestId, "send invites prepared", { eventId: body.eventId, requestedCount: body.guests?.length || 0, lumaRecipientCount: guests.length, inviteLimit, hasMessage: Boolean(message) });

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
          message,
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
    endsAt: event.end_at || null,
    visibility: event.visibility || null,
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
    const error = new Error("Missing LUMA_API_KEY. Add it to .env.local before using live Luma data.") as HttpError;
    error.status = 503;
    throw error;
  }
}

function requireLiveWriteConfirmation(body) {
  if (body.confirm !== LIVE_WRITE_CONFIRMATION) {
    const error = new Error("Live Luma write was blocked because the request did not include an explicit confirmation token.") as HttpError;
    error.status = 400;
    throw error;
  }
}

function assertString(value, name) {
  if (!value || typeof value !== "string") {
    const error = new Error("Missing required " + name + ".") as HttpError;
    error.status = 400;
    throw error;
  }
}

function normalizeLumaSessionToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
    const error = new Error("The Luma session token is not valid.") as HttpError;
    error.status = 403;
    error.code = "LUMA_SESSION_INVALID";
    throw error;
  }
  return token;
}

async function lumaPrivateCheckInFetch({ requestId, lumaSessionToken, body }) {
  const startedAt = Date.now();
  const response = await fetch(new URL("/event/admin/update-check-in", LUMA_PRIVATE_BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-luma-auth-session": lumaSessionToken,
      "x-luma-client-type": "luma-web",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (response.ok) {
    await debugLog(requestId, "private Luma check-in fetch success", {
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response.status === 204 ? {} : response.json();
  }

  const upstreamMessage = await response.text();
  const expired = response.status === 400 || response.status === 401 || response.status === 403;
  await debugLog(requestId, "private Luma check-in fetch error", {
    status: response.status,
    expired,
    durationMs: Date.now() - startedAt,
  }, "error");
  const error = new Error(expired
    ? "Your Luma session token is missing or expired. Paste a fresh token to continue."
    : `Luma check-in failed (${response.status})${upstreamMessage ? "." : ""}`) as HttpError;
  error.status = expired ? 403 : 502;
  error.code = expired ? "LUMA_SESSION_INVALID" : "LUMA_PRIVATE_API_ERROR";
  throw error;
}

async function lumaPrivateGet({ requestId, lumaSessionToken, path, params, operation }): Promise<any> {
  const startedAt = Date.now();
  const url = new URL(path, LUMA_PRIVATE_BASE_URL);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-luma-auth-session": lumaSessionToken,
      "x-luma-client-type": "luma-web",
    },
    cache: "no-store",
  });
  if (response.ok) {
    await debugLog(requestId, `private Luma ${operation} success`, {
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response.status === 204 ? null : response.json();
  }

  const expired = response.status === 400 || response.status === 401 || response.status === 403;
  await debugLog(requestId, `private Luma ${operation} error`, {
    status: response.status,
    expired,
    durationMs: Date.now() - startedAt,
  }, "error");
  const error = new Error(expired
    ? "Your Luma session token is missing or expired. Paste a fresh token to continue."
    : `Luma ${operation} failed (${response.status}).`) as HttpError;
  error.status = expired ? 403 : 502;
  error.code = expired ? "LUMA_SESSION_INVALID" : "LUMA_PRIVATE_API_ERROR";
  throw error;
}

async function lumaPrivatePost({ requestId, lumaSessionToken, path, body, operation }): Promise<any> {
  const startedAt = Date.now();
  const response = await fetch(new URL(path, LUMA_PRIVATE_BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-luma-auth-session": lumaSessionToken,
      "x-luma-client-type": "luma-web",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (response.ok) {
    await debugLog(requestId, `private Luma ${operation} success`, {
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response.status === 204 ? null : response.json();
  }

  const expired = response.status === 401 || response.status === 403;
  await debugLog(requestId, `private Luma ${operation} error`, {
    status: response.status,
    expired,
    durationMs: Date.now() - startedAt,
  }, "error");
  const error = new Error(expired
    ? "Your Luma session token is missing or expired. Paste a fresh token to continue."
    : `Luma ${operation} failed (${response.status}).`) as HttpError;
  error.status = expired ? 403 : 502;
  error.code = expired ? "LUMA_SESSION_INVALID" : "LUMA_PRIVATE_API_ERROR";
  throw error;
}

async function waitForLumaTask({ requestId, lumaSessionToken, taskId }) {
  if (!taskId) return;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await wait(500);
    const task = await lumaPrivateGet({
      requestId,
      lumaSessionToken,
      path: "/task/get-status",
      params: { task_id: taskId },
      operation: "email task status",
    });
    if (task?.status === "success") return;
    if (task?.status === "failure") {
      const error = new Error(firstString(task.error_message) || "Luma could not send the reinvite email.") as HttpError;
      error.status = 502;
      error.code = "LUMA_INVITE_EMAIL_FAILED";
      throw error;
    }
  }
  const error = new Error("Luma did not finish sending the reinvite email in time. The guest was left unchanged.") as HttpError;
  error.status = 504;
  error.code = "LUMA_INVITE_EMAIL_UNCONFIRMED";
  throw error;
}

function lumaTimelineEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.timeline)) return payload.timeline;
  if (Array.isArray(payload?.entries)) return payload.entries;
  return [];
}

function lumaTimelineEntryId(entry) {
  return firstString(entry?.id, entry?.api_id, entry?.email?.api_id)
    || [entry?.type, entry?.timestamp, entry?.email?.subject].filter(Boolean).join(":");
}

async function fetchBounded(path: string, { params = {}, maxEntries, maxPages, requestId, requestDelayMs = 0 }: AnyRecord) {
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

async function lumaFetch(path: string, { method = "GET", params = {}, body, requestId, logParams = params, allowNotFound = false }: AnyRecord = {}): Promise<any> {
  const url = new URL(path, LUMA_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
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
  const request = (async () => {
    const maxRateLimitRetries = safeInt("LUMA_RATE_LIMIT_MAX_RETRIES", 8, 0, 20);
    const baseDelayMs = safeInt("LUMA_RATE_LIMIT_BASE_DELAY_MS", 1_000, 100, 30_000);
    const maxDelayMs = safeInt("LUMA_RATE_LIMIT_MAX_DELAY_MS", 30_000, 1_000, 120_000);
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-luma-api-key": process.env.LUMA_API_KEY,
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      if (allowNotFound && response.status === 404) {
        await debugLog(requestId, "luma fetch not found", { ...logDetails, status: 404, durationMs: Date.now() - startedAt });
        return null;
      }
      if (response.status === 429 && attempt < maxRateLimitRetries) {
        const delayMs = rateLimitBackoffMs({
          retryAfter: response.headers.get("retry-after"),
          attempt,
          baseMs: baseDelayMs,
          maxMs: maxDelayMs,
        });
        await response.text();
        await debugLog(requestId, "luma fetch rate limited; retrying", {
          ...logDetails,
          status: 429,
          attempt: attempt + 1,
          maxRateLimitRetries,
          delayMs,
          durationMs: Date.now() - startedAt,
        });
        await wait(delayMs);
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        await debugLog(requestId, "luma fetch error", { ...logDetails, status: response.status, response: text, durationMs: Date.now() - startedAt }, "error");
        const error = new Error("Luma API " + response.status + ": " + (text || response.statusText)) as HttpError;
        error.status = response.status;
        throw error;
      }

      await debugLog(requestId, "luma fetch success", { ...logDetails, status: response.status, durationMs: Date.now() - startedAt, rateLimitRetries: attempt });
      if (response.status === 204) return {};
      return response.json();
    }
  })();

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
function safeInt(envName: string, fallback: number, min: number, max: number) {
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

function eventGuestScanInFlightStore(): Map<string, Promise<any>> {
  if (!globalThis[EVENT_GUEST_SCAN_IN_FLIGHT_KEY]) globalThis[EVENT_GUEST_SCAN_IN_FLIGHT_KEY] = new Map();
  return globalThis[EVENT_GUEST_SCAN_IN_FLIGHT_KEY];
}

async function coalesceEventGuestScan(eventId: string, requestId: string, scan: () => Promise<any>) {
  const store = eventGuestScanInFlightStore();
  const pending = store.get(eventId);
  if (pending) {
    await debugLog(requestId, "event guest scan in-flight reuse", { eventId });
    return pending;
  }
  const request = scan();
  store.set(eventId, request);
  try {
    return await request;
  } finally {
    if (store.get(eventId) === request) store.delete(eventId);
  }
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

function eventGuestCacheKey(eventId) {
  return "event-guests:v3:" + eventId;
}

function clearEventGuestCache(eventId) {
  cacheStore().delete(eventGuestCacheKey(eventId));
  cacheStore().delete("event-guests:v2:" + eventId);
  cacheStore().delete("event-guests:" + eventId);
}

function clearCachePrefix(prefix) {
  for (const key of cacheStore().keys()) {
    if (key.startsWith(prefix)) cacheStore().delete(key);
  }
}

async function loadIndexedGuestPayload(
  eventId,
  guestQuery,
  cacheKey,
  diagnosticReporter?: EventSwitchDiagnosticReporter,
  knownEventBoundary?: { startsAt: Date | null; date: Date | null } | null,
) {
  const snapshotLimit = safeInt("LUMA_INDEX_GUEST_CACHE_MAX_ENTRIES", 1000, 25, 5000);
  const snapshotResult = await listIndexedEventGuests(eventId, {
    filter: "all",
    search: "",
    tags: [],
    cursor: 0,
    pageSize: snapshotLimit,
    includeSummary: false,
  }, prefixEventSwitchDiagnosticReporter(diagnosticReporter, "snapshot"), knownEventBoundary);
  const { indexHasGuests, ...snapshot } = snapshotResult;
  if (!indexHasGuests) return null;

  if (!snapshot.pageInfo.hasMore) {
    writeCache(cacheKey, snapshot, cacheTtlMs("LUMA_GUEST_CACHE_SECONDS", 600));
    return {
      payload: filterGuestPayload(snapshot, guestQuery),
      snapshotCached: true,
    };
  }

  const requestedResult = await listIndexedEventGuests(eventId, {
    ...guestQuery,
    includeSummary: false,
  }, prefixEventSwitchDiagnosticReporter(diagnosticReporter, "requested_page"), knownEventBoundary);
  const { indexHasGuests: _indexHasGuests, ...requestedPayload } = requestedResult;
  return {
    payload: {
      ...requestedPayload,
      ...(guestQuery.includeSummary === false
        ? {}
        : { stats: snapshot.stats, analyticsQuestions: snapshot.analyticsQuestions }),
    },
    snapshotCached: false,
  };
}

async function loadIndexedGuestPage(
  eventId,
  guestQuery,
  diagnosticReporter?: EventSwitchDiagnosticReporter,
  knownEventBoundary?: { startsAt: Date | null; date: Date | null } | null,
) {
  const indexedResult = await listIndexedEventGuests(eventId, {
    ...guestQuery,
    includeSummary: false,
    includeEventCounts: guestQuery.filter === "new_referrals",
  }, diagnosticReporter, knownEventBoundary);
  const { indexHasGuests: _indexHasGuests, ...payload } = indexedResult;
  return { payload, snapshotCached: false };
}

// EVENT_SWITCH_DIAGNOSTICS: temporary collector keeps timing instrumentation out of normal response payloads.
function createEventSwitchDiagnosticCollector(diagnosticId: string, prefix: string) {
  const phases: Array<Record<string, any>> = [];
  const report: EventSwitchDiagnosticReporter | undefined = diagnosticId
    ? (stage, durationMs, details = {}) => phases.push({ stage: `${prefix}.${stage}`, durationMs, ...details })
    : undefined;
  return { phases, report };
}

function prefixEventSwitchDiagnosticReporter(reporter: EventSwitchDiagnosticReporter | undefined, prefix: string) {
  if (!reporter) return undefined;
  return (stage: string, durationMs: number, details = {}) => reporter(`${prefix}.${stage}`, durationMs, details);
}

function parseKnownEventBoundary(params: URLSearchParams) {
  const startsAtValue = params.get("event_starts_at") || "";
  const dateValue = params.get("event_date") || "";
  const startsAt = startsAtValue ? new Date(startsAtValue) : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? new Date(`${dateValue}T00:00:00.000Z`) : null;
  const validStartsAt = startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null;
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null;
  return validStartsAt || validDate ? { startsAt: validStartsAt, date: validDate } : null;
}

async function refreshManagedData({ requestId, rawEvents }: AnyRecord) {
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
      clearEventGuestCache(event.id);
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

async function tracePersonActivity({ requestId, tracePersonId, traceEmail, forceRefresh, traceScope, startedAt }: AnyRecord) {
  const target = {
    id: normalizeTraceValue(tracePersonId),
    email: normalizeEmail(traceEmail),
  };

  if (!target.id && !target.email) {
    const error = new Error("Trace requires a Luma person id or email.") as HttpError;
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
      clearEventGuestCache(event.id);
    } catch (error) {
      failedEventCount += 1;
      await debugLog(requestId, "trace direct lookup error", { eventId: event.id, status: error.status || 500, message: error.message }, "error");
    }
  }

  const reconciliation = hasLumaDb()
    ? await removeIndexedTraceRecordsMissingFromEvents({ tracePersonId, traceEmail, scannedEventIds, matchedEventIds })
    : { deletedCount: 0 };

  records.sort((a, b) => new Date(b.eventStartsAt || b.eventDate || b.sortAt).getTime() - new Date(a.eventStartsAt || a.eventDate || a.sortAt).getTime());

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

async function writeSnapshotToIndex({ requestId, rawEvent, event, guests, rawGuests }: AnyRecord) {
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

async function classifyAfterEventSync({ requestId, eventId, personIds }: AnyRecord) {
  const startedAt = Date.now();
  try {
    const result = await runAutomaticTagClassifier({ personIds });
    if (result.changedCount) {
      clearEventGuestCache(eventId);
      clearCachePrefix("trace-person:");
    }
    await debugLog(requestId, "auto-tags event classification success", {
      eventId,
      mode: result.mode,
      evaluatedCount: result.evaluatedCount,
      matchedCount: result.matchedCount,
      addedCount: result.addedCount,
      removedCount: result.removedCount,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await debugLog(requestId, "auto-tags event classification error", {
      eventId,
      status: error.status || 500,
      message: error.message,
      durationMs: Date.now() - startedAt,
    }, "error");
    return { ok: false, status: "error", error: error.message };
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
  return value.replace(/(x-luma-api-key|x-luma-auth-session|api[_-]?key|authorization)([\s:=]+)([^\s,}]+)/gi, "$1$2[redacted]");
}

function truncateLogValue(value) {
  return value.length > 600 ? value.slice(0, 600) + "...[truncated]" : value;
}

function privateLumaReferrer(payload) {
  const referrer = extractLumaReferrer(payload);
  return referrer ? { ...referrer, detailsVersion: 1 } : null;
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
  return extractLumaReferrer(guest);
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

function jsonError(error: any, requestId: string) {
  return Response.json(
    {
      ok: false,
      error: error.message,
      code: error.code,
      requestId,
    },
    { status: error.status || 500 },
  );
}
