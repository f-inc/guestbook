import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { EventSync, eventBody, googleEventId, readBounded, syncEvent, verifySignature, type Env, type EventData } from "./index";

const event: EventData = { id: "evt-test123", calendar_id: "cal-test", name: "Campus event", start_at: "2026-11-01T17:00:00Z", end_at: "2026-11-01T18:00:00Z", timezone: "America/Los_Angeles", url: "https://lu.ma/campus-test", visibility: "public", location_visibility: "public", geo_address_json: { full_address: "Campus" } };
const env = { SYNC_OWNER: "calendar-sync-test", LUMA_CALENDAR_ID: "cal-test", GOOGLE_CALENDAR_ID: "campus", LUMA_WEBHOOK_SECRET: "whsec_test", GOOGLE_OAUTH_CREDENTIALS: JSON.stringify({ client_id: "test", client_secret: "test", refresh_token: "test" }) } as Env;
function signed(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return new Headers({ "webhook-id": "delivery-test", "webhook-timestamp": String(timestamp), "webhook-signature": `t=${timestamp},v1=${createHmac("sha256", env.LUMA_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex")}` });
}
test("signature checks exact raw body, timestamp, and replay age", async () => {
  const body = JSON.stringify({ type: "event.created", data: event }); const headers = signed(body);
  assert.notEqual(await verifySignature(body, headers, env.LUMA_WEBHOOK_SECRET), null);
  assert.equal(await verifySignature(body + " ", headers, env.LUMA_WEBHOOK_SECRET), null);
  assert.equal(await verifySignature(body, signed(body, 1), env.LUMA_WEBHOOK_SECRET), null);
  headers.set("webhook-timestamp", "2");
  assert.equal(await verifySignature(body, headers, env.LUMA_WEBHOOK_SECRET), null);
});
test("untrusted requests and other calendars cannot enqueue writes", async () => {
  const body = JSON.stringify({ type: "event.created", data: { ...event, calendar_id: "cal-other" } });
  assert.equal((await worker.fetch(new Request("https://test/webhooks/luma", { method: "POST", body }), env)).status, 401);
  const response = await worker.fetch(new Request("https://test/webhooks/luma", { method: "POST", body, headers: signed(body) }), env);
  assert.deepEqual(await response.json(), { ok: true, ignored: true });
});
test("body cap applies to streaming requests without content-length", async () => {
  await assert.rejects(readBounded(new Request("https://test", { method: "POST", body: "12345" }), 4), /body_limit/);
});
test("calendar projection preserves timezone and hides restricted information", () => {
  const body = eventBody({ ...event, location_visibility: "guests-only", description: "private description" });
  assert.equal(body.location, ""); assert.equal(body.start.timeZone, "America/Los_Angeles");
  assert.equal(body.description, "Details and registration: https://luma.com/campus-test");
  assert.equal("attendees" in body, false);
  assert.throws(() => eventBody({ ...event, end_at: event.start_at }), /invalid_event_dates/);
});
test("stable IDs satisfy Google base32hex requirements", async () => {
  assert.match(await googleEventId(event.id), /^[0-9a-v]{5,1024}$/);
  assert.equal(await googleEventId(event.id), await googleEventId(event.id));
});
test("new event creates once and retry updates the same ID", async () => {
  let saved: any; const writes: string[] = [];
  const fetcher: any = async (url: string, init: RequestInit = {}) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "test" });
    if (init.method === "POST") { writes.push("create"); saved = { ...JSON.parse(init.body as string), etag: "test" }; return Response.json(saved); }
    if (init.method === "PATCH") { writes.push("update"); assert.equal((init.headers as any)["If-Match"], "test"); return Response.json({}); }
    if (url.includes("?")) return Response.json({ items: [] });
    return saved ? Response.json(saved) : new Response(null, { status: 404 });
  };
  assert.equal(await syncEvent({ type: "event.created", data: event }, env, fetcher), "created");
  assert.equal(await syncEvent({ type: "event.updated", data: { ...event, name: "Edited" } }, env, fetcher), "updated");
  assert.deepEqual(writes, ["create", "update"]);
});
test("adopts manual event only with exact Luma URL; preserves unrelated fields", async () => {
  let patch: any;
  const fetcher: any = async (url: string, init: RequestInit = {}) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "test" });
    if (init.method === "PATCH") { patch = JSON.parse(init.body as string); assert.ok(url.includes("manual")); return Response.json({}); }
    if (url.includes("q=")) return Response.json({ items: [{ id: "manual", description: "https://lu.ma/campus-test", attendees: [{ email: "keep@example.com" }] }, { id: "unrelated", description: "https://lu.ma/campus-test-other" }] });
    if (url.includes("?")) return Response.json({ items: [] });
    return new Response(null, { status: 404 });
  };
  assert.equal(await syncEvent({ type: "event.updated", data: event }, env, fetcher), "updated");
  assert.equal("attendees" in patch, false); assert.equal("reminders" in patch, false);
});
test("nonpublic events never create; cancellation only touches managed copies", async () => {
  let writes = 0; let existing: any;
  const fetcher: any = async (url: string, init: RequestInit = {}) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "test" });
    if (init.method) { writes++; const patch = JSON.parse(init.body as string); assert.equal(patch.status, "cancelled"); assert.equal(patch.location, ""); return Response.json({}); }
    if (url.includes("?")) return Response.json({ items: [] });
    return existing ? Response.json(existing) : new Response(null, { status: 404 });
  };
  assert.equal(await syncEvent({ type: "event.created", data: { ...event, visibility: "private" } }, env, fetcher), "ignored_nonpublic_or_canceled");
  existing = { id: "existing" };
  assert.equal(await syncEvent({ type: "event.canceled", data: event }, env, fetcher), "ignored_unmanaged_event");
  existing.extendedProperties = { private: { syncOwner: env.SYNC_OWNER } };
  assert.equal(await syncEvent({ type: "event.canceled", data: event }, env, fetcher), "canceled");
  assert.equal(writes, 1);
});
test("durable enqueue deduplicates, rejects stale edits, and keeps cancellation final", async () => {
  const data = new Map(); let alarms = 0;
  const state: any = { blockConcurrencyWhile: async (fn: any) => fn(), storage: { get: async (key: string) => data.get(key), put: async (obj: any) => Object.entries(obj).forEach(([k,v]) => data.set(k,v)), setAlarm: async () => { alarms++; } } };
  const object = new EventSync(state, env);
  const send = (type: string, timestamp: number, webhookId: string) => object.fetch(new Request("https://internal", { method: "POST", body: JSON.stringify({ type, data: event, timestamp, webhookId }) }));
  assert.equal((await send("event.created", 10, "a")).status, 202);
  assert.deepEqual(await (await send("event.updated", 9, "b")).json(), { ok: true, duplicate: true });
  assert.deepEqual(await (await send("event.created", 10, "a")).json(), { ok: true, duplicate: true });
  await send("event.canceled", 11, "c");
  assert.deepEqual(await (await send("event.updated", 12, "d")).json(), { ok: true, duplicate: true });
  assert.equal(alarms, 2);
});
