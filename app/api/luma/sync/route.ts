// @ts-nocheck
import { appendFile, mkdir } from "node:fs/promises";
import nodePath from "node:path";
import { createSyncRun, finishSyncRun, getEventSyncStates, getIndexStats, hasLumaDb, recordEventSyncState, upsertNormalizedLumaSnapshot } from "../db";
import { lumaEventDate } from "../event-date";
import { orderAvatarCandidates } from "../../../avatar-order";

export const runtime = "nodejs";

const LUMA_BASE_URL = "https://public-api.luma.com";
const DEFAULT_DEBUG_LOG_PATH = nodePath.join(/*turbopackIgnore: true*/ process.cwd(), ".debug", "luma-api.log");

const approvalToStatus = {
  approved: "going",
  pending_approval: "registered",
  invited: "invited",
  declined: "declined",
  waitlist: "waitlisted",
  session: "going",
};

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("run") === "1") return runSync(request);

  const requestId = createRequestId();
  try {
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

export async function POST(request) {
  return runSync(request);
}

async function runSync(request) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  let syncRun = null;
  let eventCount = 0;
  let refreshedEventCount = 0;
  let skippedFreshEventCount = 0;
  let guestCount = 0;
  const people = new Set();
  let failedEventCount = 0;
  let truncatedGuestEventCount = 0;

  try {
    assertApiKey();
    assertDb();
    requireSyncAuth(request);

    const body = request.method === "POST" ? await readJsonBody(request) : {};
    const limits = syncLimits(body);
    currentSyncRequestDelayMs = limits.requestDelayMs;
    const forceRefresh = shouldForceRefresh(request, body);
    await debugLog(requestId, "luma sync start", { limits, forceRefresh, hasEventIds: Array.isArray(body.eventIds) && body.eventIds.length > 0 });
    syncRun = await createSyncRun({ requestId, limits });

    const rawEvents = await loadSyncEvents({ requestId, body, limits });
    const managedEvents = rawEvents.entries.filter((event) => event.platform !== "external");
    const syncStates = forceRefresh ? new Map() : await getEventSyncStates(managedEvents.map((event) => event.id).filter(Boolean));

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
          await upsertNormalizedLumaSnapshot({
            rawEvent,
            event,
            guests: [],
            rawGuests: [],
          });
          await recordEventSyncState({
            eventId: event.id,
            guestCount: syncDecision.lastGuestCount,
            status: "skipped_fresh",
            truncated: false,
            syncGuests: false,
          });
          skippedFreshEventCount += 1;
          await debugLog(requestId, "luma sync event skipped fresh", { eventId: event.id, reason: syncDecision.reason, lastGuestSyncAt: syncDecision.lastGuestSyncAt });
          continue;
        }

        await debugLog(requestId, "luma sync event guests start", { eventId: event.id, maxGuestsPerEvent: limits.maxGuestsPerEvent });
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

    const status = failedEventCount ? "partial_error" : "success";
    if (syncRun) {
      await finishSyncRun(syncRun.id, {
        status,
        eventCount,
        guestCount,
        personCount: people.size,
        error: failedEventCount ? failedEventCount + " event(s) failed. Check .debug/luma-api.log for requestId " + requestId + "." : null,
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
      eventListTruncated: rawEvents.truncated,
      guestListsTruncated: truncatedGuestEventCount > 0,
      truncatedGuestEventCount,
      durationMs: Date.now() - startedAt,
    });

    return Response.json({
      ok: failedEventCount === 0,
      status,
      requestId,
      eventCount,
      refreshedEventCount,
      skippedFreshEventCount,
      guestCount,
      personCount: people.size,
      failedEventCount,
      truncated: rawEvents.truncated || truncatedGuestEventCount > 0,
      eventListTruncated: rawEvents.truncated,
      guestListsTruncated: truncatedGuestEventCount > 0,
      truncatedGuestEventCount,
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
  }
}

async function loadSyncEvents({ requestId, body, limits }) {
  const eventIds = Array.isArray(body.eventIds) ? body.eventIds.filter((eventId) => typeof eventId === "string" && eventId.trim()).slice(0, limits.maxEvents) : [];
  if (eventIds.length) {
    const entries = [];
    for (const eventId of eventIds) {
      entries.push(
        await lumaFetch("/v1/events/get", {
          requestId,
          params: { event_id: eventId },
        }),
      );
    }
    return { entries, truncated: body.eventIds.length > eventIds.length };
  }

  return fetchBounded("/v1/calendars/events/list", {
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

function syncLimits(body = {}) {
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

async function fetchBounded(path, { params = {}, maxEntries, maxPages, requestId }) {
  const entries = [];
  let cursor = null;
  let pages = 0;
  do {
    await debugLog(requestId, "sync bounded fetch page start", { path, page: pages + 1, maxPages, maxEntries, hasCursor: Boolean(cursor) });
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
    await debugLog(requestId, "sync bounded fetch page success", { path, page: pages, pageEntries: page.entries?.length || 0, totalEntries: entries.length, hasMore: Boolean(cursor) });
  } while (cursor && entries.length < maxEntries && pages < maxPages);

  const truncated = Boolean(cursor || entries.length > maxEntries);
  await debugLog(requestId, "sync bounded fetch complete", { path, pages, entries: Math.min(entries.length, maxEntries), truncated });
  return {
    entries: entries.slice(0, maxEntries),
    truncated,
  };
}

async function lumaFetch(path, { method = "GET", params = {}, body, requestId } = {}) {
  await throttleSyncRequest();
  const url = new URL(path, LUMA_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const startedAt = Date.now();
  const logDetails = { method, path, params: safeLogObject(params) };
  await debugLog(requestId, "sync luma fetch start", logDetails);
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-luma-api-key": process.env.LUMA_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    await debugLog(requestId, "sync luma fetch error", { ...logDetails, status: response.status, response: text, durationMs: Date.now() - startedAt }, "error");
    const error = new Error("Luma API " + response.status + ": " + (text || response.statusText));
    error.status = response.status;
    throw error;
  }

  await debugLog(requestId, "sync luma fetch success", { ...logDetails, status: response.status, durationMs: Date.now() - startedAt });
  if (response.status === 204) return {};
  return response.json();
}

function shouldForceRefresh(request, body = {}) {
  const url = new URL(request.url);
  return body.force === true || body.refresh === true || url.searchParams.get("force") === "1" || url.searchParams.get("refresh") === "1";
}

function shouldRefreshEventGuests({ state, forceRefresh, staleAfterMinutes }) {
  if (forceRefresh) return { refresh: true, reason: "force" };
  if (!state) return { refresh: true, reason: "never_synced" };
  if (state.error) return { refresh: true, reason: "previous_error" };
  if (state.truncated) return { refresh: true, reason: "previous_truncated" };
  if (state.lastStatus && !["success", "skipped_fresh"].includes(state.lastStatus)) return { refresh: true, reason: "previous_status_" + state.lastStatus };
  if (!state.lastGuestSyncAt) return { refresh: true, reason: "missing_guest_sync_time" };

  const staleMs = staleAfterMinutes * 60 * 1000;
  if (staleMs === 0) return { refresh: true, reason: "stale_disabled" };
  const ageMs = Date.now() - new Date(state.lastGuestSyncAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs >= staleMs) return { refresh: true, reason: "stale" };

  return {
    refresh: false,
    reason: "fresh",
    lastGuestSyncAt: state.lastGuestSyncAt.toISOString(),
    lastGuestCount: state.lastGuestCount || 0,
  };
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
    guests: [],
    guestsLoaded: false,
    source: "luma",
  };
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
  const referrer = extractReferrer(guest);
  const avatarCandidates = extractAvatarCandidates(guest);
  const searchText = [profileDescription, extractRegistrationAnswerText(registrationAnswers), socialLinks.map((link) => link.display).join(" "), referrerText(referrer)].filter(Boolean).join(" ");
  const status = checkedIn ? "checked_in" : isPast && guest.approval_status === "approved" ? "no_show" : approvalToStatus[guest.approval_status] || "registered";
  const registeredAt = firstString(guest.registered_at, guest.joined_at, status === "invited" ? "" : guest.created_at);

  return {
    person: {
      id: personId,
      lumaUserId,
      name: firstString(guest.user_name, guest.name, guest.user?.name) || [guest.user_first_name, guest.user_last_name].filter(Boolean).join(" ") || firstString(guest.user_email, guest.email, guest.user?.email) || "Unnamed guest",
      email: firstString(guest.user_email, guest.email, guest.user?.email),
      title: extractGuestTitle(guest, registrationAnswers),
      profileDescription,
      bio: profileDescription,
      avatarUrl: avatarCandidates[0] || "",
      avatarCandidates,
      profileUrl: extractProfileUrl(guest) || lumaProfileUrl(lumaUserId),
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
    avatarUrl: avatarCandidates[0] || "",
    avatarCandidates,
    profileUrl: extractProfileUrl(guest) || lumaProfileUrl(lumaUserId),
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
  const direct = [
    guest.user_bio,
    guest.user_description,
    guest.profile_description,
    guest.profile?.description,
    guest.profile?.bio,
    guest.user?.description,
    guest.user?.bio,
    guest.user?.profile?.bio,
    guest.user?.profile?.description,
  ].find((value) => typeof value === "string" && value.trim());
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
  const jobTitle = firstString(guest.user_title, guest.user?.title, guest.profile?.title, rawCompanyAnswer?.value?.job_title, rawCompanyAnswer?.value?.title, rawCompanyAnswer?.value?.role);
  const company = firstString(guest.user_company, guest.user?.company, guest.profile?.company, rawCompanyAnswer?.value?.company_name, rawCompanyAnswer?.value?.company, rawCompanyAnswer?.value?.organization);
  return [jobTitle, company].filter(Boolean).join(" at ") || companyAnswer?.value || "Luma guest";
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
  return firstUrlLike(event.cover_url, event.cover_image_url, event.image_url, event.thumbnail_url, event.event_image_url, event.cover?.url, event.cover?.image_url, event.calendar?.avatar_url);
}

function extractProfileUrl(guest) {
  return firstUrlLike(guest.user_url, guest.profile_url, guest.luma_profile_url, guest.user?.url, guest.user?.profile_url, guest.user?.luma_profile_url, guest.profile?.url);
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

function requireSyncAuth(request) {
  const secret = process.env.GUESTBOOK_SYNC_SECRET;
  if (!secret && process.env.NODE_ENV !== "production") return;
  if (!secret) {
    const error = new Error("Missing GUESTBOOK_SYNC_SECRET. Refusing to run sync without a secret in production.");
    error.status = 503;
    throw error;
  }

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const headerSecret = request.headers.get("x-guestbook-sync-secret") || "";
  const urlSecret = new URL(request.url).searchParams.get("secret") || "";
  if (bearer === secret || headerSecret === secret || urlSecret === secret) return;

  const error = new Error("Unauthorized sync request.");
  error.status = 401;
  throw error;
}

function assertApiKey() {
  if (!process.env.LUMA_API_KEY) {
    const error = new Error("Missing LUMA_API_KEY. Add it before syncing live Luma data.");
    error.status = 503;
    throw error;
  }
}

function assertDb() {
  if (!hasLumaDb()) {
    const error = new Error("Missing DB_URL. Add a PostgreSQL connection string before syncing.");
    error.status = 503;
    throw error;
  }
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function boundedBodyInt(bodyValue, envName, fallback, min, max) {
  const raw = bodyValue ?? process.env[envName] ?? "";
  const value = Number.parseInt(raw, 10);
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
