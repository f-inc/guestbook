/// <reference types="@cloudflare/workers-types" />

export interface Env {
  SYNC_OWNER: string;
  LUMA_CALENDAR_ID: string;
  GOOGLE_CALENDAR_ID: string;
  LUMA_WEBHOOK_SECRET: string;
  GOOGLE_OAUTH_CREDENTIALS?: string;
  GOOGLE_SERVICE_ACCOUNT?: string;
  EVENT_SYNC: DurableObjectNamespace;
}
export type EventData = {
  id: string; calendar_id: string; name: string; start_at: string; end_at: string;
  timezone: string; url: string; visibility: string; location_visibility: string;
  geo_address_json?: { full_address?: string; address?: string; description?: string } | null;
  description?: string; description_md?: string;
};
type Delivery = { type: string; data: EventData; timestamp: number; webhookId: string };
const types = new Set(["event.created", "event.updated", "event.canceled"]);
const encoder = new TextEncoder();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return json({ ok: true, worker: "calendar-sync" });
    if (path !== "/webhooks/luma") return json({ error: "Not found" }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!env.SYNC_OWNER || !env.LUMA_WEBHOOK_SECRET || !(env.GOOGLE_OAUTH_CREDENTIALS || env.GOOGLE_SERVICE_ACCOUNT)) return json({ error: "Integration not configured" }, 503);
    try {
      const body = await readBounded(request, 1_000_000);
      const timestamp = await verifySignature(body, request.headers, env.LUMA_WEBHOOK_SECRET);
      if (timestamp === null) return json({ error: "Invalid signature" }, 401);
      const payload = JSON.parse(body);
      if (!types.has(payload.type)) return json({ ok: true, ignored: true });
      const data = payload.data as EventData;
      if (!data || !/^evt-[a-zA-Z0-9]+$/.test(data.id || "")) return json({ error: "Invalid event" }, 400);
      if (data.calendar_id !== env.LUMA_CALENDAR_ID) return json({ ok: true, ignored: true });
      const webhookId = request.headers.get("webhook-id");
      if (!webhookId || webhookId.length > 255) return json({ error: "Invalid delivery ID" }, 400);
      // One object per event serializes writes and durably retries Google failures.
      const object = env.EVENT_SYNC.get(env.EVENT_SYNC.idFromName(data.id));
      return await object.fetch("https://event-sync/delivery", { method: "POST", body: JSON.stringify({ type: payload.type, data, timestamp, webhookId }) });
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "Invalid JSON" }, 400);
      if (error instanceof Error && error.message === "body_limit") return json({ error: "Body too large" }, 413);
      console.error("webhook_accept_failed");
      return json({ error: "Unable to accept delivery" }, 503);
    }
  },
};

export class EventSync {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const delivery: Delivery = await request.json();
      const last = await this.state.storage.get<{ timestamp: number; webhookId: string; canceled: boolean }>("latest");
      if (last && (last.webhookId === delivery.webhookId || last.timestamp > delivery.timestamp || (last.canceled && delivery.type !== "event.canceled"))) return json({ ok: true, duplicate: true });
      // Set the alarm before saving the job so an interrupted request cannot strand it.
      await this.state.storage.setAlarm(Date.now() + 1000);
      await this.state.storage.put({ pending: { ...delivery, attempt: 0 }, latest: { timestamp: delivery.timestamp, webhookId: delivery.webhookId, canceled: delivery.type === "event.canceled" } });
      return json({ ok: true, queued: true }, 202);
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const pending = await this.state.storage.get<Delivery & { attempt: number }>("pending");
      if (!pending) return;
      try {
        const outcome = await syncEvent(pending, this.env);
        await this.state.storage.delete("pending");
        await this.state.storage.put("result", { outcome, at: Date.now() });
        console.log(JSON.stringify({ action: "calendar_sync", eventId: pending.data.id, outcome }));
      } catch {
        const attempt = pending.attempt + 1;
        await this.state.storage.put("pending", { ...pending, attempt });
        // Keep retrying at a bounded rate; credentials can be repaired without lost jobs.
        await this.state.storage.setAlarm(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt, 7)));
        console.error(JSON.stringify({ action: "calendar_sync_failed", eventId: pending.data.id, attempt }));
      }
    });
  }
}

export async function readBounded(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("body_limit"); }
    chunks.push(value);
  }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(joined);
}

export async function verifySignature(body: string, headers: Headers, secret: string, now = Date.now()): Promise<number | null> {
  const parts = (headers.get("webhook-signature") || "").split(",").map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith("t="))?.slice(2) || "";
  if (!/^\d+$/.test(timestamp) || headers.get("webhook-timestamp") !== timestamp || Math.abs(now / 1000 - Number(timestamp)) > 300) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  for (const field of parts.filter(p => p.startsWith("v1="))) {
    const hex = field.slice(3);
    if (!/^[a-fA-F0-9]{64}$/.test(hex)) continue;
    const bytes = Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
    if (await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`${timestamp}.${body}`))) return Number(timestamp);
  }
  return null;
}

export function lumaUrl(value: string): string {
  const url = new URL(value.startsWith("https://") ? value : `https://luma.com/${value}`);
  if (!["luma.com", "lu.ma"].includes(url.hostname) || url.protocol !== "https:") throw new Error("invalid_luma_url");
  return `https://luma.com${url.pathname.replace(/\/$/, "")}`;
}

export async function googleEventId(eventId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(eventId));
  return "luma" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export function eventBody(event: EventData, syncOwner = "calendar-sync") {
  const start = new Date(event.start_at); const end = new Date(event.end_at);
  if (!event.name || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("invalid_event_dates");
  const url = lumaUrl(event.url);
  // The destination is public. Never copy guest-only addresses, meeting links, or attendees.
  return {
    summary: event.name,
    description: `Details and registration: ${url}`,
    location: event.location_visibility === "public" ? (event.geo_address_json?.full_address || event.geo_address_json?.address || "") : "",
    start: { dateTime: start.toISOString(), timeZone: event.timezone || "America/Los_Angeles" },
    end: { dateTime: end.toISOString(), timeZone: event.timezone || "America/Los_Angeles" },
    source: { title: "Luma", url },
    extendedProperties: { private: { lumaEventId: event.id, lumaCalendarId: event.calendar_id, syncOwner } },
  };
}

export async function googleToken(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  let params: URLSearchParams;
  if (env.GOOGLE_OAUTH_CREDENTIALS) {
    const credentials = JSON.parse(env.GOOGLE_OAUTH_CREDENTIALS);
    params = new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.client_id, client_secret: credentials.client_secret, refresh_token: credentials.refresh_token });
  } else {
    const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT || "{}");
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = base64url(encoder.encode(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/calendar.events", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
    const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
    const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`));
    params = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${base64url(new Uint8Array(signature))}` });
  }
  const response = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", body: params, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`google_auth_${response.status}`);
  const result: any = await response.json();
  if (!result.access_token) throw new Error("missing_access_token");
  return result.access_token;
}
function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function syncEvent(delivery: Pick<Delivery, "type" | "data">, env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  const event = delivery.data;
  if (event.calendar_id !== env.LUMA_CALENDAR_ID) return "wrong_calendar";
  const remove = delivery.type === "event.canceled" || event.visibility !== "public";
  // blockConcurrencyWhile has a 30s limit; cap the entire Google operation at 25s.
  const deadline = AbortSignal.timeout(25_000);
  const boundedFetch: typeof fetch = (url, init = {}) => fetcher(url, { ...init, signal: deadline });
  const token = await googleToken(env, boundedFetch);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;
  const call = async (url: string, init: RequestInit = {}) => boundedFetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  const stableId = await googleEventId(event.id);
  const direct = await call(`${base}/${stableId}`);
  let existing: any;
  if (direct.ok) existing = await direct.json();
  else if (![404, 410].includes(direct.status)) throw new Error(`google_lookup_${direct.status}`);
  if (!existing) {
    const lookup = await call(`${base}?${new URLSearchParams({ privateExtendedProperty: `lumaEventId=${event.id}`, maxResults: "10" })}`);
    if (!lookup.ok) throw new Error(`google_lookup_${lookup.status}`);
    const result: any = await lookup.json();
    if (result.nextPageToken || result.items?.length > 1) throw new Error("ambiguous_existing_events");
    existing = result.items?.[0];
  }
  // Adopt an existing manual entry only if it links to the exact same Luma event.
  if (!existing && !remove) {
    const url = lumaUrl(event.url); const slug = new URL(url).pathname.slice(1);
    const lookup = await call(`${base}?${new URLSearchParams({ q: slug, maxResults: "100" })}`);
    if (!lookup.ok) throw new Error(`google_lookup_${lookup.status}`);
    const result: any = await lookup.json();
    if (result.nextPageToken) throw new Error("existing_search_limit");
    const matches = (result.items || []).filter((item: any) => {
      if (item.extendedProperties?.private?.syncOwner && item.extendedProperties.private.syncOwner !== env.SYNC_OWNER) return false;
      const links = `${item.description || ""} ${item.source?.url || ""}`.match(/https:\/\/(?:luma\.com|lu\.ma)\/[^\s<>"']+/g) || [];
      return links.some((link: string) => { try { return lumaUrl(link) === url; } catch { return false; } });
    });
    if (matches.length > 1) throw new Error("ambiguous_manual_events");
    existing = matches[0];
  }
  if (remove) {
    if (!existing) return "ignored_nonpublic_or_canceled";
    if (existing.extendedProperties?.private?.syncOwner !== env.SYNC_OWNER) return "ignored_unmanaged_event";
    if (existing.status === "cancelled") return "already_canceled";
    const response = await call(`${base}/${existing.id}?sendUpdates=none`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", summary: "Luma event unavailable", description: "", location: "" }), headers: existing.etag ? { "If-Match": existing.etag } : {} });
    if (!response.ok) throw new Error(`google_cancel_${response.status}`);
    return "canceled";
  }
  const body = eventBody(event, env.SYNC_OWNER);
  body.extendedProperties.private = { ...existing?.extendedProperties?.private, ...body.extendedProperties.private };
  // A canceled Google event must not be resurrected by a delayed Luma retry.
  if (existing?.status === "cancelled") return "already_canceled";
  const response = await call(existing ? `${base}/${existing.id}?sendUpdates=none` : `${base}?sendUpdates=none`, {
    method: existing ? "PATCH" : "POST",
    headers: existing?.etag ? { "If-Match": existing.etag } : {},
    body: JSON.stringify(existing ? body : { id: stableId, ...body, reminders: { useDefault: false } }),
  });
  if (!response.ok) throw new Error(`google_write_${response.status}`);
  return existing ? "updated" : "created";
}
