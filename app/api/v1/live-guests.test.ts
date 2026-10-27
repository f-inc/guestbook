import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLiveGuests, normalizeLiveGuest } from "./live-guests";
import { clearLumaEventCredentialCache } from "../luma/api-keys";
async function withCredentials(run: () => Promise<void>) {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (/^LUMA_(API_KEY|SESSION_TOKEN)(?:_\d+)?$/.test(name)) delete process.env[name];
  process.env.LUMA_API_KEY = "mock-secret";
  process.env.LUMA_RATE_LIMIT_MAX_RETRIES = "0";
  process.env.GUESTBOOK_DEBUG_LOG_PATH = "/tmp/guestbook-live-api-test.log";
  clearLumaEventCredentialCache();
  try { await run(); } finally { process.env = saved; clearLumaEventCredentialCache(); }
}
test("live guest reads fetch every upstream page and every status on every request without caching", async () => withCredentials(async () => {
  const cursors: (string | null)[] = [];
  let version = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/events/guests/list");
    assert.equal(url.searchParams.get("event_id"), "evt-live");
    assert.equal(url.searchParams.has("approval_status"), false);
    assert.equal(init.cache, "no-store");
    const cursor = url.searchParams.get("pagination_cursor");
    cursors.push(cursor);
    if (!cursor) return Response.json({ entries: [{ id: "g1", user_id: "u1", approval_status: "declined", user_name: `Version ${++version}` }], has_more: true, next_cursor: "page2" });
    return Response.json({ entries: [{ id: "g2", user_id: "u2", approval_status: "waitlist" }], has_more: false });
  };
  const first = await fetchLiveGuests("evt-live", "test-live", { fetchImpl });
  const second = await fetchLiveGuests("evt-live", "test-live2", { fetchImpl });
  assert.deepEqual(cursors, [null, "page2", null, "page2"]);
  assert.deepEqual(first.guests.map(g => g.status), ["declined", "waitlisted"]);
  assert.equal(second.guests[0].name, "Version 2");
  assert.ok(first.fetchedAt);
}));
test("check-ins use all ticket timestamps and unknown approval statuses are preserved", () => {
  const guest = normalizeLiveGuest({ id: "g", approval_status: "approved", event_tickets: [{ checked_in_at: "2026-10-27T12:00:00Z" }, { checked_in_at: "2026-10-27T10:00:00Z" }] });
  assert.equal(guest.checkedInAt, "2026-10-27T10:00:00Z");
  assert.equal(guest.status, "checked_in");
  assert.equal(guest.personId, "guest:g");
  assert.equal(normalizeLiveGuest({ id: "g2", approval_status: "new_status" }).status, "new_status");
  assert.equal(normalizeLiveGuest({ id: "g3", email: "secret@example.test" }).name, "Unnamed guest");
});
test("live reads refuse malformed pages, broken/repeated cursors, duplicates, and truncation", async () => withCredentials(async () => {
  for (const payload of [
    {}, { entries: [], has_more: true }, { entries: [], next_cursor: 12 },
    { entries: [{}] }, { entries: [null] },
    { entries: [{ id: "g" }, { id: "g" }] },
    { entries: [], next_cursor: "repeat" },
    { entries: Array.from({ length: 10001 }, (_, i) => ({ id: `g${i}` })) },
  ]) {
    await assert.rejects(fetchLiveGuests("evt-live", "test-invalid", { fetchImpl: async () => Response.json(payload) }), { status: 502 });
  }
}));
test("live read errors do not leak upstream response bodies or fall back to stale data", async () => withCredentials(async () => {
  for (const status of [403, 429, 500, 502]) {
    await assert.rejects(fetchLiveGuests("evt-live", "test-error", { fetchImpl: async () => new Response("private email and credentials", { status }) }), (error: any) => {
      assert.equal(error.status, status === 429 ? 503 : 502);
      assert.ok(!error.message.includes("private email"));
      return true;
    });
  }
}));
test("live reads have a deadline and bound concurrent scans", async () => withCredentials(async () => {
  const fetchImpl: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const pending = Array.from({ length: 3 }, (_, i) => fetchLiveGuests(`evt-${i}`, "test-busy", { fetchImpl, timeoutMs: 50 }));
  const settlements = Promise.allSettled(pending);
  await assert.rejects(fetchLiveGuests("evt-4", "test-busy", { fetchImpl }), { status: 503 });
  const results = await settlements;
  for (const result of results) { assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.reason.status, 504); }
}));
test("live reads fall back to configured session access and paginate its complete guest list", async () => withCredentials(async () => {
  process.env.LUMA_SESSION_TOKEN = "mock-session";
  const paths: string[] = [];
  const result = await fetchLiveGuests("evt-live", "test-session", { fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.startsWith("/v1/")) return new Response("denied", { status: 403 });
    assert.equal(new Headers(init.headers).get("x-luma-auth-session"), "mock-session");
    if (!url.searchParams.has("pagination_cursor")) return Response.json({ entries: [{ api_id: "g1", user_api_id: "u1", approval_status: "invited" }], next_cursor: "more", has_more: true });
    return Response.json({ entries: [{ api_id: "g2", user_api_id: "u2", approval_status: "approved" }], has_more: false });
  } });
  assert.deepEqual(result.guests.map(g => g.status), ["invited", "going"]);
  assert.deepEqual(paths, ["/v1/events/guests/list", "/event/admin/get-guests", "/event/admin/get-guests"]);
}));
