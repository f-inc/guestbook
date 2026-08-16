import { rateLimitBackoffMs } from "./rate-limit-retry";
import {
  knownLumaEventCredential,
  lumaApiKeys,
  lumaSessionTokens,
  rememberLumaEventCredential,
  type LumaApiKey,
  type LumaCredentialSource,
  type LumaSessionToken,
} from "./api-keys";

type AnyRecord = Record<string, any>;
type HttpError = Error & { status?: number; code?: string };
type LogLevel = "info" | "error";
type Logger = (requestId: string, event: string, details?: AnyRecord, level?: LogLevel) => Promise<void>;
type CatalogFailure = { credentialName: string; status: number; message: string };
type CatalogGroup = { entries: any[]; truncated: boolean; credential: LumaCredentialSource };

type ClientOptions = {
  logger: Logger;
  beforeRequest?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  inFlight?: Map<string, Promise<any>>;
  logPrefix?: string;
};

type PublicRequestOptions = {
  method?: string;
  params?: AnyRecord;
  body?: unknown;
  requestId: string;
  logParams?: AnyRecord;
  allowNotFound?: boolean;
  apiKey?: LumaApiKey | null;
};

type PrivateRequestOptions = {
  requestId: string;
  sessionToken?: LumaSessionToken | string;
  lumaSessionToken?: string;
  path: string;
  params?: AnyRecord;
  body?: unknown;
  operation: string;
};

const LUMA_BASE_URL = "https://public-api.luma.com";
const LUMA_PRIVATE_BASE_URL = "https://api.luma.com";

export function createLumaClient({
  logger,
  beforeRequest = async () => {},
  fetchImpl = fetch,
  inFlight,
  logPrefix = "",
}: ClientOptions) {
  const log = (requestId: string, event: string, details: AnyRecord = {}, level: LogLevel = "info") => (
    logger(requestId, `${logPrefix}${event}`, details, level)
  );

  async function publicRequest(path: string, {
    method = "GET",
    params = {},
    body,
    requestId,
    logParams = params,
    allowNotFound = false,
    apiKey = lumaApiKeys()[0],
  }: PublicRequestOptions): Promise<any> {
    if (!apiKey) throw httpError("Missing Luma API key.", 503);
    const url = new URL(path, LUMA_BASE_URL);
    appendSearchParams(url, params);
    const requestKey = method === "GET" && inFlight ? `${apiKey.envName} ${method} ${url}` : null;
    const logDetails = { method, path, apiKeyName: apiKey.envName, params: safeLogObject(logParams) };
    if (requestKey) {
      const pending = inFlight.get(requestKey);
      if (pending) {
        await log(requestId, "luma fetch in-flight reuse", logDetails);
        return pending;
      }
    }

    const startedAt = Date.now();
    await log(requestId, "luma fetch start", logDetails);
    const operation = (async () => {
      const maximumRetries = environmentInt("LUMA_RATE_LIMIT_MAX_RETRIES", 8, 0, 20);
      const baseDelayMs = environmentInt("LUMA_RATE_LIMIT_BASE_DELAY_MS", 1_000, 100, 30_000);
      const maximumDelayMs = environmentInt("LUMA_RATE_LIMIT_MAX_DELAY_MS", 30_000, 1_000, 120_000);
      for (let attempt = 0; ; attempt += 1) {
        await beforeRequest();
        const response = await fetchImpl(url, {
          method,
          headers: { "content-type": "application/json", "x-luma-api-key": apiKey.value },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
        });
        if (allowNotFound && response.status === 404) {
          await response.text();
          await log(requestId, "luma fetch not found", { ...logDetails, status: 404, durationMs: Date.now() - startedAt });
          return null;
        }
        if (response.status === 429 && attempt < maximumRetries) {
          const delayMs = rateLimitBackoffMs({
            retryAfter: response.headers.get("retry-after"),
            attempt,
            baseMs: baseDelayMs,
            maxMs: maximumDelayMs,
          });
          await response.text();
          await log(requestId, "luma fetch rate limited; retrying", {
            ...logDetails,
            status: 429,
            attempt: attempt + 1,
            maximumRetries,
            delayMs,
            durationMs: Date.now() - startedAt,
          });
          await wait(delayMs);
          continue;
        }
        if (!response.ok) {
          const responseText = await response.text();
          await log(requestId, "luma fetch error", { ...logDetails, status: response.status, durationMs: Date.now() - startedAt }, "error");
          throw httpError(`Luma API ${response.status}: ${responseText || response.statusText}`, response.status);
        }
        await log(requestId, "luma fetch success", {
          ...logDetails,
          status: response.status,
          durationMs: Date.now() - startedAt,
          rateLimitRetries: attempt,
        });
        return response.status === 204 ? {} : response.json();
      }
    })();

    if (!requestKey) return operation;
    inFlight!.set(requestKey, operation);
    try {
      return await operation;
    } finally {
      inFlight!.delete(requestKey);
    }
  }

  async function privateGet(options: PrivateRequestOptions) {
    return privateRequest("GET", options);
  }

  async function privatePost(options: PrivateRequestOptions) {
    return privateRequest("POST", options);
  }

  async function privateRequest(method: "GET" | "POST", options: PrivateRequestOptions): Promise<any> {
    const credential = privateCredential(options);
    const url = new URL(options.path, LUMA_PRIVATE_BASE_URL);
    appendSearchParams(url, options.params || {});
    const startedAt = Date.now();
    const logDetails = {
      method,
      path: options.path,
      operation: options.operation,
      sessionTokenName: credential.envName,
      params: safeLogObject(options.params || {}),
    };
    await beforeRequest();
    await log(options.requestId, "private Luma fetch start", logDetails);
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        "x-luma-auth-session": credential.value,
        "x-luma-client-type": "luma-web",
      },
      body: method === "POST" && options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
    if (!response.ok) {
      await response.text();
      const expired = [400, 401, 403].includes(response.status);
      await log(options.requestId, "private Luma fetch error", {
        ...logDetails,
        status: response.status,
        expired,
        durationMs: Date.now() - startedAt,
      }, "error");
      const error = httpError(expired
        ? "Your Luma session token is missing, expired, or lacks access."
        : `Luma ${options.operation} failed (${response.status}).`, expired ? 403 : response.status);
      error.code = expired ? "LUMA_SESSION_INVALID" : "LUMA_PRIVATE_API_ERROR";
      throw error;
    }
    await log(options.requestId, "private Luma fetch success", {
      ...logDetails,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response.status === 204 ? null : response.json();
  }

  async function fetchBounded(path: string, {
    params = {}, maxEntries, maxPages, requestId, requestDelayMs = 0, apiKey = null,
  }: AnyRecord) {
    const entries: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (pages > 0 && requestDelayMs) await wait(requestDelayMs);
      await log(requestId, "bounded fetch page start", { path, page: pages + 1, maxPages, maxEntries, hasCursor: Boolean(cursor) });
      const page = await publicRequest(path, {
        requestId,
        apiKey,
        params: { ...params, ...(cursor ? { pagination_cursor: cursor } : {}) },
      });
      pages += 1;
      entries.push(...(Array.isArray(page?.entries) ? page.entries : []));
      cursor = page?.next_cursor || null;
      await log(requestId, "bounded fetch page success", {
        path, page: pages, pageEntries: page?.entries?.length || 0, totalEntries: entries.length, hasMore: Boolean(cursor),
      });
    } while (cursor && entries.length < maxEntries && pages < maxPages);
    const truncated = Boolean(cursor || entries.length > maxEntries);
    await log(requestId, "bounded fetch complete", { path, pages, entries: Math.min(entries.length, maxEntries), truncated });
    return { entries: entries.slice(0, maxEntries), truncated };
  }

  async function fetchSessionEventCatalog({ requestId, sessionToken, maxEntries, maxPages, pageSize, requestDelayMs = 0 }: {
    requestId: string;
    sessionToken: LumaSessionToken;
    maxEntries: number;
    maxPages: number;
    pageSize: number;
    requestDelayMs?: number;
  }) {
    const entries: any[] = [];
    let truncated = false;
    for (const period of ["future", "past"] as const) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        if (pages > 0 && requestDelayMs) await wait(requestDelayMs);
        const page = await privateGet({
          requestId,
          sessionToken,
          path: "/home/get-events",
          params: { period, pagination_limit: Math.min(100, pageSize), ...(cursor ? { pagination_cursor: cursor } : {}) },
          operation: `event catalog (${sessionToken.envName})`,
        });
        pages += 1;
        for (const card of Array.isArray(page?.entries) ? page.entries : []) {
          if (!card?.manager_info && !card?.host_info) continue;
          const event = sessionEventFromCard(card);
          if (event.id) entries.push(event);
          if (entries.length >= maxEntries) break;
        }
        cursor = page?.next_cursor || null;
        if (entries.length >= maxEntries || pages >= maxPages) {
          truncated ||= Boolean(cursor || page?.has_more);
          break;
        }
      } while (cursor);
      if (entries.length >= maxEntries) break;
    }
    return { entries: entries.slice(0, maxEntries), truncated };
  }

  async function fetchEventsAcrossCredentials({ requestId, params, maxEntries, maxPages, requestDelayMs = 0 }: AnyRecord) {
    const groups: CatalogGroup[] = [];
    const credentialFailures: CatalogFailure[] = [];
    for (const apiKey of lumaApiKeys()) {
      try {
        const result = await fetchBounded("/v1/calendars/events/list", {
          requestId, params, maxEntries, maxPages, requestDelayMs, apiKey,
        });
        groups.push({ ...result, credential: { type: "api-key", value: apiKey } });
      } catch (error: any) {
        credentialFailures.push({ credentialName: apiKey.envName, status: error.status || 500, message: error.message });
      }
    }
    for (const sessionToken of lumaSessionTokens()) {
      try {
        const result = await fetchSessionEventCatalog({
          requestId,
          sessionToken,
          maxEntries,
          maxPages,
          pageSize: Number(params.pagination_limit) || 25,
          requestDelayMs,
        });
        groups.push({ ...result, credential: { type: "session-token", value: sessionToken } });
      } catch (error: any) {
        credentialFailures.push({ credentialName: sessionToken.envName, status: error.status || 500, message: error.message });
      }
    }
    if (!groups.length && credentialFailures.length) {
      throw httpError("None of the configured Luma credentials could load events.", credentialFailures[0].status);
    }
    const { entries, credentialSources } = mergeCatalogGroups(groups);
    await log(requestId, "multi-credential event catalog complete", {
      apiKeyCount: lumaApiKeys().length,
      sessionTokenCount: lumaSessionTokens().length,
      successfulCredentialCount: groups.length,
      failedCredentialNames: credentialFailures.map((failure) => failure.credentialName),
      eventCount: entries.length,
      truncatedCredentialCount: groups.filter((result) => result.truncated).length,
    }, credentialFailures.length ? "error" : "info");
    return {
      entries,
      credentialSources,
      credentialFailures,
      failures: [],
      truncated: credentialFailures.length > 0 || groups.some((result) => result.truncated),
    };
  }

  async function resolveEventApiKey(eventId: string, requestId: string): Promise<LumaApiKey> {
    const cached = knownLumaEventCredential(eventId);
    if (cached?.type === "api-key") return cached.value;
    let lastError: HttpError | null = null;
    for (const apiKey of lumaApiKeys()) {
      try {
        const event = await publicRequest("/v1/events/get", { requestId, params: { event_id: eventId }, apiKey });
        rememberLumaEventCredential(event?.id || eventId, { type: "api-key", value: apiKey });
        return apiKey;
      } catch (error: any) {
        lastError = error;
        if (![401, 403, 404].includes(error.status || 0)) throw error;
      }
    }
    throw lastError || httpError("Luma event was not found for any configured API key.", 404);
  }

  async function resolveEventReadCredential(eventId: string, requestId: string): Promise<LumaCredentialSource> {
    const cached = knownLumaEventCredential(eventId);
    if (cached) return cached;
    try {
      return { type: "api-key", value: await resolveEventApiKey(eventId, requestId) };
    } catch (apiError: any) {
      let lastError = apiError;
      for (const sessionToken of lumaSessionTokens()) {
        try {
          const payload = await privateGet({
            requestId,
            sessionToken,
            path: "/event/admin/get",
            params: { event_api_id: eventId },
            operation: `event ownership (${sessionToken.envName})`,
          });
          const event = sessionEventFromAdmin(payload);
          rememberLumaEventCredential(event.id || eventId, { type: "session-token", value: sessionToken });
          return { type: "session-token", value: sessionToken };
        } catch (error: any) {
          lastError = error;
        }
      }
      throw lastError;
    }
  }

  async function publicRequestForEvent(path: string, eventId: string, options: Omit<PublicRequestOptions, "apiKey">) {
    const apiKey = await resolveEventApiKey(eventId, options.requestId);
    return publicRequest(path, { ...options, apiKey });
  }

  async function fetchSessionGuestsBounded({ requestId, sessionToken, eventId, pageSize, maxEntries, maxPages, requestDelayMs = 0 }: {
    requestId: string;
    sessionToken: LumaSessionToken;
    eventId: string;
    pageSize: number;
    maxEntries: number;
    maxPages: number;
    requestDelayMs?: number;
  }) {
    const entries: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (pages > 0 && requestDelayMs) await wait(requestDelayMs);
      const page = await privateGet({
        requestId,
        sessionToken,
        path: "/event/admin/get-guests",
        params: {
          event_api_id: eventId,
          pagination_limit: Math.min(100, pageSize),
          sort_column: "registered_or_created_at",
          sort_direction: "desc",
          ...(cursor ? { pagination_cursor: cursor } : {}),
        },
        operation: `guest list (${sessionToken.envName})`,
      });
      pages += 1;
      entries.push(...(Array.isArray(page?.entries) ? page.entries : []));
      cursor = page?.next_cursor || null;
    } while (cursor && entries.length < maxEntries && pages < maxPages);
    return { entries: entries.slice(0, maxEntries), truncated: Boolean(cursor || entries.length > maxEntries) };
  }

  return {
    fetchBounded,
    fetchEventsAcrossCredentials,
    fetchSessionEventCatalog,
    fetchSessionGuestsBounded,
    privateGet,
    privatePost,
    publicRequest,
    publicRequestForEvent,
    resolveEventApiKey,
    resolveEventReadCredential,
  };
}

export function sessionEventFromCard(card: any) {
  const event = card?.event || card || {};
  return {
    ...event,
    id: event.id || event.api_id || card?.api_id || "",
    calendar: event.calendar || card?.calendar || null,
    guest_count: event.guest_count || card?.guest_count || 0,
  };
}

export function sessionEventFromAdmin(payload: any) {
  const event = payload?.event || payload || {};
  return { ...event, id: event.id || event.api_id || "", calendar: event.calendar || payload?.calendar || null };
}

function mergeCatalogGroups(groups: CatalogGroup[]) {
  const selected = new Map<string, { event: any; credential: LumaCredentialSource }>();
  for (const group of groups) {
    for (const event of group.entries) {
      const eventId = typeof event?.id === "string" ? event.id : "";
      if (!eventId) continue;
      const existing = selected.get(eventId);
      if (!existing || credentialPriority(group.credential) < credentialPriority(existing.credential)) {
        selected.set(eventId, { event, credential: group.credential });
      }
    }
  }
  const rows = [...selected.values()].sort((left, right) => eventTimestamp(right.event) - eventTimestamp(left.event));
  for (const row of rows) rememberLumaEventCredential(row.event.id, row.credential);
  return {
    entries: rows.map((row) => row.event),
    credentialSources: Object.fromEntries(rows.map((row) => [row.event.id, {
      type: row.credential.type,
      envName: row.credential.value.envName,
    }])),
  };
}

function credentialPriority(source: LumaCredentialSource) {
  return (source.type === "api-key" ? 0 : 1) * 1_000_000 + source.value.order;
}

function privateCredential(options: PrivateRequestOptions) {
  if (typeof options.sessionToken === "object" && options.sessionToken) return options.sessionToken;
  const value = typeof options.sessionToken === "string" ? options.sessionToken : options.lumaSessionToken || "";
  if (!value) throw httpError("Missing Luma session token.", 403);
  return { envName: "provided-session", value, order: 0 };
}

function appendSearchParams(url: URL, params: AnyRecord) {
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
}

function safeLogObject(value: AnyRecord) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => {
    const lowered = key.toLowerCase();
    if (lowered.includes("token") || lowered.includes("authorization") || lowered.includes("secret")) return [key, "[redacted]"];
    if (lowered.includes("email")) return [key, "[redacted-email]"];
    if (lowered.includes("id") && ["guest", "user", "rsvp", "person"].some((kind) => lowered.includes(kind))) return [key, "[redacted-id]"];
    return [key, Array.isArray(item) ? `[${item.length} values]` : item];
  }));
}

function environmentInt(envName: string, fallback: number, minimum: number, maximum: number) {
  const value = Number.parseInt(process.env[envName] || "", 10);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function eventTimestamp(event: any) {
  const parsed = Date.parse(event?.start_at || event?.startAt || event?.date || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function httpError(message: string, status: number) {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
