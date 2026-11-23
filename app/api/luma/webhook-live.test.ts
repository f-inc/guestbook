import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { DatabaseNotifications, notificationDatabaseUrl, CHANGE_CHANNEL } from "./webhooks/notifications";
import { parseWebhookEnvelope, webhookRetryDelay } from "./webhooks/envelope";
import { subscribeToLiveUpdates } from "../../live-updates";

test("supports event lifecycle, refunds and calendar additions without treating external events as managed", () => {
  for (const type of ["event.created", "event.updated", "event.canceled", "calendar.event.added"]) {
    const result = parseWebhookEnvelope(JSON.stringify({ type, data: { id: "evt-test", platform: "luma" } }));
    assert.ok(result.supported);
    assert.equal(result.eventId, "evt-test");
  }
  assert.equal(parseWebhookEnvelope(JSON.stringify({ type: "calendar.event.added", data: { id: "external-test", platform: "external" } })).supported, false);
  assert.equal(parseWebhookEnvelope(JSON.stringify({ type: "guest.refunded", data: { id: "gst-test", user_id: "usr-test", event: { id: "evt-test" } } })).supported, true);
  assert.throws(() => parseWebhookEnvelope("[]"), /type is required/);
  assert.throws(() => parseWebhookEnvelope('{"type":"guest.updated","data":{}}'), /IDs are required/);
  assert.equal(webhookRetryDelay(1), 5000);
  assert.equal(webhookRetryDelay(100), 3_600_000);
});

test("LISTEN rejects transaction-pool URLs and keeps connection credentials server-only", () => {
  assert.throws(() => notificationDatabaseUrl({ DB_URL: "postgresql://example.com:6543/db" }), /session-mode/);
  assert.throws(() => notificationDatabaseUrl({ DB_URL: "postgresql://example.com/db?pgbouncer=true" }), /session-mode/);
  assert.equal(notificationDatabaseUrl({ DB_URL: "postgresql://example.com/db?connection_limit=2&schema=public" }), "postgresql://example.com/db");
  assert.equal(notificationDatabaseUrl({ DB_URL: "postgresql://example.com:6543/db", DB_NOTIFY_URL: "postgresql://example.com:5432/db" }), "postgresql://example.com:5432/db");
});

test("database subscribers share a session, wait for LISTEN before ready, and release the final connection", async () => {
  const queries: string[] = [];
  let closed = false;
  const client = Object.assign(new EventEmitter(), {
    async connect() {}, async query(sql: string) { queries.push(sql); }, async end() { closed = true; },
  });
  let created = 0;
  const bus = new DatabaseNotifications(() => { created++; return client as any; });
  const notifications: string[] = [];
  const ready = new Promise<void>((resolve) => {
    const stop = bus.subscribe({ ready() {
      assert.deepEqual(queries, ["LISTEN guestbook_webhook_inbox", "LISTEN guestbook_index_changed"]);
      resolve();
    }, disconnected() {}, change(channel, payload) { notifications.push(channel + payload); } });
    (client as any).stop = stop;
  });
  await ready;
  const stopSecond = bus.subscribe({ ready() {}, disconnected() {}, change() {} });
  assert.equal(created, 1);
  client.emit("notification", { channel: CHANGE_CHANNEL, payload: '{"eventId":"evt-test"}' });
  assert.equal(notifications.length, 1);
  (client as any).stop();
  assert.equal(closed, false);
  stopSecond();
  assert.equal(closed, true);
});

test("live client handles fragmented messages over one authenticated stream and aborts without polling", async () => {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let requests = 0;
  const events: string[] = [];
  await subscribeToLiveUpdates(async (url) => {
    requests++;
    assert.equal(url, "/api/luma/changes");
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of ["event: rea", "dy\ndata: {}\n\n: heartbeat\n\n", "event: change\ndata: {\"eventId\":\"evt-test\"}\n\n"]) controller.enqueue(encoder.encode(chunk));
    } }));
  }, (type) => { events.push(type); if (type === "change") abort.abort(); }, abort.signal);
  assert.deepEqual(events, ["ready", "change"]);
  assert.equal(requests, 1);
});

test("live client stops reconnecting when authentication is rejected", async () => {
  const events: string[] = [];
  let requests = 0;
  await subscribeToLiveUpdates(async () => { requests++; return new Response(null, { status: 401 }); },
    (type) => events.push(type), new AbortController().signal);
  assert.deepEqual(events, ["unauthorized"]);
  assert.equal(requests, 1);
});

test("resource reconciliation uses the paired key and preserves Retry-After without exposing provider bodies", async () => {
  const { readWebhookResource } = await import("./webhooks/process");
  const previous = process.env.LUMA_API_KEY_2;
  process.env.LUMA_API_KEY_2 = "test_paired_key";
  try {
    await assert.rejects(readWebhookResource("/v1/events/get", { event_id: "evt-test" }, "LUMA_WEBHOOK_SECRET_2", (async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("event_id"), "evt-test");
      assert.equal(new Headers(init?.headers).get("x-luma-api-key"), "test_paired_key");
      return new Response("private provider body", { status: 429, headers: { "retry-after": "120" } });
    }) as typeof fetch), (error: any) => {
      assert.equal(error.code, "LUMA_HTTP_429");
      assert.equal(error.retryAfter, 120_000);
      assert.equal(error.message, "Luma resource unavailable.");
      return true;
    });
  } finally { if (previous === undefined) delete process.env.LUMA_API_KEY_2; else process.env.LUMA_API_KEY_2 = previous; }
});
