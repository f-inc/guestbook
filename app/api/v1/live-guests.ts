import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createLumaClient } from "../luma/luma-client";
import { lumaApiKeys, lumaSessionTokens } from "../luma/api-keys";
import { fail } from "./shared";

// Single explicitly requested event only. Never persist integration reads to the
// database, scan the calendar, or return a partial guest list as complete.
const MAX_GUESTS = 10_000;
const MAX_PAGES = 200;
const TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = 3;
let active = 0;
export type LiveGuest = {
  personId: string; lumaGuestId: string | null; name: string; email: string | null;
  status: string; lumaApprovalStatus: string | null; registeredAt: string | null;
  invitedAt: string | null; approvedAt: string | null; checkedInAt: string | null;
  checkedIn: boolean; updatedAt: string | null;
};
export type LiveGuestSnapshot = { guests: LiveGuest[]; fetchedAt: string };
function incomplete(message: string): never { throw Object.assign(new Error(message), { status: 502, liveGuestSafe: true }); }
const text = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && Boolean(v.trim()))?.trim() || null;
export function normalizeLiveGuest(raw: any): LiveGuest {
  const lumaGuestId = text(raw.id, raw.api_id, raw.guest_id, raw.guest_api_id);
  // Never use an email as an ID or display-name fallback: those fields are
  // returned even to keys which cannot read email addresses.
  const personId = text(raw.user_id, raw.user_api_id, raw.user?.id, raw.user?.api_id) || (lumaGuestId ? `guest:${lumaGuestId}` : null);
  if (!personId) incomplete("Luma returned a guest without a stable ID. No guest list was returned.");
  const tickets = Array.isArray(raw.event_tickets) ? raw.event_tickets : [];
  const checkIns = [raw.checked_in_at, raw.event_ticket?.checked_in_at, ...tickets.map(ticket => ticket?.checked_in_at)]
    .filter((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(a) - Date.parse(b));
  const checkedInAt = checkIns[0] || null;
  const lumaApprovalStatus = text(raw.approval_status);
  const statuses: Record<string, string> = { approved: "going", session: "going", pending_approval: "registered", invited: "invited", declined: "declined", waitlist: "waitlisted" };
  const status = checkedInAt ? "checked_in" : statuses[lumaApprovalStatus || ""] || lumaApprovalStatus || "unknown";
  return {
    personId, lumaGuestId,
    name: text(raw.user_name, raw.name, raw.user?.name) || text([raw.user_first_name, raw.user_last_name].filter(Boolean).join(" ")) || "Unnamed guest",
    email: text(raw.user_email, raw.email, raw.user?.email),
    status, lumaApprovalStatus, checkedIn: Boolean(checkedInAt), checkedInAt,
    registeredAt: text(raw.registered_at, raw.joined_at, status === "invited" ? null : raw.created_at),
    invitedAt: text(raw.invited_at, raw.invite_sent_at, status === "invited" ? raw.created_at : null),
    approvedAt: text(raw.approved_at), updatedAt: text(raw.updated_at),
  };
}

// Only allowlist non-personal diagnostics. Upstream error bodies, headers,
// credentials, guest records, and pagination cursors are never written here.
async function log(requestId: string, event: string, details: Record<string, any> = {}) {
  const safe: Record<string, unknown> = {};
  for (const key of ["path", "status", "page", "pages", "entries", "pageEntries", "totalEntries", "truncated", "durationMs", "hasMore", "hasCursor", "credentialType"])
    if (["string", "number", "boolean"].includes(typeof details[key])) safe[key] = details[key];
  const filename = process.env.GUESTBOOK_DEBUG_LOG_PATH || path.join(process.cwd(), ".debug", "luma-api.log");
  try {
    await mkdir(path.dirname(filename), { recursive: true });
    await appendFile(filename, JSON.stringify({ timestamp: new Date().toISOString(), requestId, event: `integration ${event}`, details: safe }) + "\n");
  } catch { /* Debug logging must not prevent the read. */ }
}

export async function fetchLiveGuests(eventId: string, requestId: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<LiveGuestSnapshot> {
  if (!lumaApiKeys().length && !lumaSessionTokens().length) fail("Luma read credentials are not configured.", 503);
  if (active >= MAX_CONCURRENT) fail("Live Luma reads are busy. Retry shortly.", 503);
  active++;
  const controller = new AbortController();
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  const cursors = new Set<string>();
  const client = createLumaClient({
    logger: log,
    beforeRequest: async () => { controller.signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error("deadline"); },
    fetchImpl: async (input, init) => {
      // A new credential attempt restarts the traversal from page one.
      if (!new URL(String(input)).searchParams.has("pagination_cursor")) cursors.clear();
      const response = await (options.fetchImpl || fetch)(input, { ...init, signal: controller.signal, redirect: "error" });
      if (response.ok) {
        const payload: any = await response.clone().json();
        if (!Array.isArray(payload?.entries) || payload.entries.some((row: any) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Invalid Luma guest page");
        if (payload.next_cursor != null && typeof payload.next_cursor !== "string") throw new Error("Invalid Luma cursor");
        if (payload.has_more === true && !payload.next_cursor) throw new Error("Missing Luma cursor");
        if (payload.next_cursor) {
          const marker = new URL(String(input)).pathname + " " + payload.next_cursor;
          if (cursors.has(marker)) throw new Error("Repeated Luma cursor");
          cursors.add(marker);
        }
      }
      return response;
    },
  });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, Math.max(1, deadline - Date.now()));
    });
    const result = await Promise.race([
      client.fetchEventGuestsBounded({ eventId, requestId, pageSize: 100, maxEntries: MAX_GUESTS, maxPages: MAX_PAGES }),
      timeout,
    ]);
    if (result.truncated) incomplete("Luma guest list exceeded the live-read limit. No partial list was returned. Contact the Guestbook administrator.");
    const guests = result.entries.map(normalizeLiveGuest);
    // Repeated IDs across Luma pages can mean the list changed while paging.
    // Fail rather than silently skipping or duplicating an email recipient.
    if (new Set(guests.map(guest => guest.personId)).size !== guests.length) incomplete("Luma guest list changed during pagination. Retry the request.");
    return { guests, fetchedAt: new Date().toISOString() };
  } catch (error: any) {
    await log(requestId, "live read failed", { status: error.status || 502 });
    if (controller.signal.aborted) fail("Luma guest fetch timed out. No guest list was returned. Retry the request.", 504);
    // Never forward Luma's error text, which can contain private response data.
    if (error.liveGuestSafe) throw error;
    if (error.status === 429) fail("Luma rate limit reached. Retry the request later.", 503);
    fail("Unable to retrieve a complete fresh guest list from Luma. Check event access and retry.", 502);
  } finally {
    clearTimeout(timer!);
    controller.abort();
    active--;
  }
}
