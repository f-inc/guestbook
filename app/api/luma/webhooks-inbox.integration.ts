import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { spawn } from "node:child_process";

const url = process.env.WEBHOOK_TEST_DATABASE_URL || "";
const parsed = new URL(url);
assert.match(parsed.searchParams.get("host") || "", /^\/private\/tmp\/guestbook-webhook-test-[^/]+\/socket$/);
assert.equal(process.env.DB_URL, url);
assert.equal(process.env.DB_NOTIFY_URL, url);
const db = new Client({ connectionString: url });
const event = { id: "evt-webhook-test", name: "Example event", start_at: "2026-11-22T20:00:00Z", end_at: "2026-11-22T22:00:00Z", timezone: "America/Los_Angeles", max_capacity: 100, visibility: "public" };
const guest = { id: "gst-test", user_id: "usr-test", user_email: "attendee@example.com", user_name: "Example Guest", approval_status: "approved", registration_answers: [], event_tickets: [], event };

before(async () => {
  await db.connect();
  const check = await db.query("SHOW data_directory");
  assert.equal(check.rows[0].data_directory, process.env.WEBHOOK_TEST_DATA_DIRECTORY);
});
after(async () => {
  const { prisma, sourcePrisma } = await import("./db");
  await Promise.all([db.end(), prisma().$disconnect(), sourcePrisma().$disconnect()]);
});

test("signed ingress durably queues, deduplicates, rejects conflicting IDs, and never accepts an invalid signature", async () => {
  const { POST } = await import("./webhooks/route");
  process.env.LUMA_WEBHOOK_SECRET = "whsec_test_only";
  const body = JSON.stringify({ type: "guest.updated", data: guest });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", process.env.LUMA_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  const request = (raw = body, signed = signature) => new Request("https://guestbook.example/api/luma/webhooks", { method: "POST", body: raw, headers: {
    "webhook-id": "wh-test-1", "webhook-timestamp": timestamp, "webhook-signature": `t=${timestamp},v1=${signed}`,
  } });
  assert.equal((await POST(request())).status, 202);
  assert.equal(((await (await POST(request())).json()) as any).duplicate, true);
  assert.equal((await POST(request(body, "0".repeat(64)))).status, 401);
  const changed = body.replace("Example Guest", "Another Guest");
  const changedSignature = createHmac("sha256", process.env.LUMA_WEBHOOK_SECRET).update(`${timestamp}.${changed}`).digest("hex");
  assert.equal((await POST(request(changed, changedSignature))).status, 409);
  const rows = await db.query("SELECT status, attempts, payload->>'type' AS type FROM luma_webhook_deliveries");
  assert.deepEqual(rows.rows, [{ status: "queued", attempts: 0, type: "guest.updated" }]);
});

test("claims are exclusive, failed processing retries, notifications follow commit, and processed payloads are removed", async () => {
  const { claimQueuedWebhook, failQueuedWebhook, completeQueuedWebhook } = await import("./webhooks/inbox");
  const claims = await Promise.all([claimQueuedWebhook(), claimQueuedWebhook()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = claims.find(Boolean)!;
  await failQueuedWebhook(row, "LUMA_HTTP_429");
  assert.equal(await claimQueuedWebhook(), null);
  await db.query("UPDATE luma_webhook_deliveries SET next_attempt_at = NOW() WHERE webhook_id = $1", [row.webhook_id]);
  const retry = (await claimQueuedWebhook())!;
  assert.equal(retry.attempts, 2);
  const listener = new Client({ connectionString: url });
  await listener.connect();
  try {
    await listener.query("LISTEN guestbook_index_changed");
    const notification = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No committed change notification")), 3000);
      listener.once("notification", (message) => { clearTimeout(timeout); resolve(message); });
    });
    await completeQueuedWebhook(retry);
    assert.deepEqual(JSON.parse((await notification).payload), { eventId: event.id });
    const saved = await db.query("SELECT status, payload, processed_at IS NOT NULL AS completed FROM luma_webhook_deliveries WHERE webhook_id = $1", [row.webhook_id]);
    assert.deepEqual(saved.rows[0], { status: "processed", payload: null, completed: true });
    assert.equal(await claimQueuedWebhook(), null);
  } finally { await listener.end(); }
});

test("expired processing leases recover after a worker crash and exhausted failures remain visible", async () => {
  const { enqueueWebhook, claimQueuedWebhook, failQueuedWebhook } = await import("./webhooks/inbox");
  const { parseWebhookEnvelope } = await import("./webhooks/envelope");
  const envelope = parseWebhookEnvelope(JSON.stringify({ type: "event.updated", data: event }));
  assert.ok(envelope.supported);
  await enqueueWebhook("wh-test-crash", envelope, "LUMA_WEBHOOK_SECRET");
  await claimQueuedWebhook();
  await db.query("UPDATE luma_webhook_deliveries SET next_attempt_at = NOW() - INTERVAL '1 minute', attempts = 9 WHERE webhook_id = 'wh-test-crash'");
  const recovered = (await claimQueuedWebhook())!;
  assert.equal(recovered.attempts, 10);
  await failQueuedWebhook(recovered, "LUMA_HTTP_503");
  assert.equal((await db.query("SELECT status FROM luma_webhook_deliveries WHERE webhook_id = 'wh-test-crash'")).rows[0].status, "dead");
  assert.equal(await claimQueuedWebhook(), null);
});

test("current guest state wins over delayed deliveries, and cancellation cannot be revived by a late registration", async () => {
  const { processQueuedWebhook } = await import("./webhooks/process");
  const originalFetch = globalThis.fetch;
  let checkedIn = true;
  const reads: string[] = [];
  process.env.LUMA_API_KEY = "test_calendar_key";
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    reads.push(url.pathname);
    if (url.pathname === "/v1/events/get") return Response.json(event);
    if (url.pathname === "/v1/events/guests/get") return Response.json({ ...guest, event_tickets: [{ checked_in_at: checkedIn ? "2026-11-22T20:05:00Z" : null }] });
    throw new Error("Unexpected upstream scan");
  }) as typeof fetch;
  const row = { webhook_id: "wh-projection-test", webhook_type: "guest.updated", event_id: event.id, guest_id: guest.id,
    secret_name: "LUMA_WEBHOOK_SECRET", attempts: 1, payload: { type: "guest.updated", data: guest } };
  try {
    await processQueuedWebhook(row);
    assert.equal((await db.query("SELECT status FROM luma_event_guests WHERE event_id = $1", [event.id])).rows[0].status, "checked_in");
    checkedIn = false;
    await processQueuedWebhook({ ...row, payload: { ...row.payload, data: { ...guest, event_tickets: [{ checked_in_at: "2026-11-22T20:05:00Z" }] } } });
    assert.equal((await db.query("SELECT status FROM luma_event_guests WHERE event_id = $1", [event.id])).rows[0].status, "going");
    await processQueuedWebhook({ ...row, webhook_type: "event.canceled", guest_id: null, payload: { type: "event.canceled", data: event } });
    const count = reads.length;
    await processQueuedWebhook(row);
    assert.equal(reads.length, count);
    assert.equal((await db.query("SELECT catalog_active FROM luma_events WHERE event_id = $1", [event.id])).rows[0].catalog_active, false);
    assert.ok(reads.every((path) => ["/v1/events/get", "/v1/events/guests/get"].includes(path)));
  } finally { globalThis.fetch = originalFetch; }
});

test("ordinary reads, including an empty guest index, never fall back to Luma", async () => {
  const { GET } = await import("./route");
  const originalFetch = globalThis.fetch;
  process.env.GUESTBOOK_KEY = "test_guestbook_key";
  globalThis.fetch = (async () => { throw new Error("Unexpected upstream polling"); }) as typeof fetch;
  try {
    for (const suffix of ["", "?event_id=evt-empty-test", "?trace_person_id=usr-test"]) {
      const response = await GET(new Request(`https://guestbook.example/api/luma${suffix}`, { headers: { "x-guestbook-key": process.env.GUESTBOOK_KEY } }));
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).indexed, true);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("authenticated live streams receive committed changes and close cleanly", async () => {
  const { GET } = await import("./changes/route");
  assert.equal((await GET(new Request("https://guestbook.example/api/luma/changes"))).status, 401);
  const abort = new AbortController();
  const response = await GET(new Request("https://guestbook.example/api/luma/changes", { signal: abort.signal,
    headers: { "x-guestbook-key": process.env.GUESTBOOK_KEY! } }));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  try {
    const ready = await reader.read();
    assert.match(new TextDecoder().decode(ready.value), /event: ready/);
    await db.query("SELECT pg_notify('guestbook_index_changed', $1)", [JSON.stringify({ eventId: event.id })]);
    const change = await reader.read();
    assert.match(new TextDecoder().decode(change.value), /event: change/);
    abort.abort();
    assert.equal((await reader.read()).done, true);
  } finally { abort.abort(); reader.releaseLock(); }
  const canceled = await GET(new Request("https://guestbook.example/api/luma/changes", {
    headers: { "x-guestbook-key": process.env.GUESTBOOK_KEY! },
  }));
  await canceled.body!.cancel();
});

test("a webhook processed in another instance invalidates previously cached audience counts", async () => {
  const { listIndexedEventCohortCounts } = await import("./db");
  const { completeQueuedWebhook } = await import("./webhooks/inbox");
  const before = await listIndexedEventCohortCounts();
  assert.equal(before.find((row) => row.eventId === event.id)?.attended, 0);
  // Simulate another process committing source data without touching this
  // process's JavaScript caches, then completing its delivery ledger entry.
  await db.query("UPDATE luma_event_guests SET status = 'checked_in', checked_in_at = NOW() WHERE event_id = $1", [event.id]);
  await completeQueuedWebhook({ webhook_id: "wh-test-1", webhook_type: "guest.updated", event_id: event.id,
    guest_id: guest.id, secret_name: "LUMA_WEBHOOK_SECRET", payload: null, attempts: 1 });
  const after = await listIndexedEventCohortCounts();
  assert.equal(after.find((row) => row.eventId === event.id)?.attended, 1);
});

test("the standalone worker recovers saved work at startup and wakes for new deliveries without polling", async () => {
  const { enqueueWebhook } = await import("./webhooks/inbox");
  const { parseWebhookEnvelope } = await import("./webhooks/envelope");
  const listener = new Client({ connectionString: url });
  await listener.connect();
  await listener.query("LISTEN guestbook_index_changed");
  const nextChange = () => new Promise<void>((resolve, reject) => {
    const onMessage = () => { clearTimeout(timeout); resolve(); };
    const timeout = setTimeout(() => { listener.removeListener("notification", onMessage); reject(new Error("Worker did not project delivery")); }, 10_000);
    listener.once("notification", onMessage);
  });
  const envelope = parseWebhookEnvelope(JSON.stringify({ type: "calendar.person.unsubscribed", data: { email: "optout@example.com" } }));
  assert.ok(envelope.supported);
  await enqueueWebhook("wh-worker-startup", envelope, "LUMA_WEBHOOK_SECRET");
  const recovered = nextChange();
  const worker = spawn(process.execPath, ["--import", "tsx", "scripts/webhook-worker.ts"], {
    env: { ...process.env, LUMA_WEBHOOK_CALENDAR_ID: "cal-test" }, stdio: "ignore",
  });
  try {
    await recovered;
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM luma_calendar_opt_outs WHERE "calendarId" = $1', ["cal-test"])).rows[0].count, 1);
    const notified = nextChange();
    await enqueueWebhook("wh-worker-notified", envelope, "LUMA_WEBHOOK_SECRET");
    await notified;
    assert.equal((await db.query("SELECT status FROM luma_webhook_deliveries WHERE webhook_id = 'wh-worker-notified'")).rows[0].status, "processed");
  } finally {
    const exited = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error("Worker did not stop cleanly")); }, 5000);
      worker.once("close", () => { clearTimeout(timeout); resolve(); });
    });
    worker.kill("SIGTERM");
    await exited;
    await listener.end();
  }
});
