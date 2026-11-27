import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { POST } from "./webhooks/route";
import { claimQueuedWebhook, completeQueuedWebhook, failQueuedWebhook } from "./webhooks/inbox";
import { processQueuedWebhook } from "./webhooks/process";
import { LUMA_WEBHOOK_TYPES } from "./webhooks/webhook";
import { disconnectDatabaseClients, sourcePrisma } from "./db";

const url = process.env.WEBHOOK_TEST_DATABASE_URL!;
const namespace = process.env.WEBHOOK_TEST_SCHEMA || "public";
const mode = process.env.GUESTBOOK_IDENTITY_MODE || "legacy";
assert.match(
  new URL(url).searchParams.get("host") || "",
  /^\/private\/tmp\/guestbook-webhook-test-[^/]+\/socket$/,
);
assert.equal(process.env.DB_URL, url);
assert.equal(process.env.DB_RUNTIME_URL, url);
assert.equal(process.env.DB_NOTIFY_URL, url);
assert.ok(["public", "guestbook"].includes(namespace));
const db = new Client({ connectionString: process.env.WEBHOOK_TEST_ADMIN_URL || url });
const secrets = {
  LUMA_WEBHOOK_SECRET: "whsec_synthetic_primary",
  LUMA_WEBHOOK_SECRET_2: "whsec_synthetic_secondary",
};
const apiKeys = {
  LUMA_WEBHOOK_SECRET: "synthetic_primary_key",
  LUMA_WEBHOOK_SECRET_2: "synthetic_secondary_key",
};
let sequence = 0;
let originalFetch: typeof fetch;
const eventFixture = () => ({
  id: `evt-${mode}-scenario-${++sequence}`,
  name: "Synthetic gathering",
  start_at: new Date(Date.now() + 86400000).toISOString(),
  end_at: new Date(Date.now() + 90000000).toISOString(),
  visibility: "public",
  max_capacity: 40,
});
const guestFixture = (event: ReturnType<typeof eventFixture>) => ({
  id: `gst-${mode}-${sequence}`,
  user_id: `usr-${mode}-${sequence}`,
  user_name: "Synthetic Attendee",
  user_email: `attendee-${mode}-${sequence}@example.test`,
  approval_status: "approved",
  registration_answers: [],
  event_tickets: [],
  event,
});
function signed(
  payload: unknown,
  options: {
    id?: string;
    secret?: keyof typeof secrets;
    timestamp?: string;
    body?: string;
    signature?: string;
  } = {},
) {
  const body = options.body ?? JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const digest =
    options.signature ??
    createHmac("sha256", secrets[options.secret || "LUMA_WEBHOOK_SECRET"])
      .update(`${timestamp}.${body}`)
      .digest("hex");
  return new Request("https://guestbook.example.test/api/luma/webhooks", {
    method: "POST",
    body,
    headers: {
      "webhook-id": options.id || `wh-${mode}-${++sequence}`,
      "webhook-timestamp": timestamp,
      "webhook-signature": `t=${timestamp},v1=${digest}`,
    },
  });
}
async function project(payload: any, secret: keyof typeof secrets = "LUMA_WEBHOOK_SECRET") {
  const id = `wh-${mode}-${++sequence}`;
  const response = await POST(signed(payload, { id, secret }));
  assert.equal(response.status, 202);
  const row = await claimQueuedWebhook();
  assert.equal(row?.webhook_id, id);
  assert.equal(row.secret_name, secret);
  await processQueuedWebhook(row);
  await completeQueuedWebhook(row);
  const saved = (
    await db.query(
      "SELECT status,payload,processed_at IS NOT NULL AS completed FROM luma_webhook_deliveries WHERE webhook_id=$1",
      [id],
    )
  ).rows[0];
  assert.deepEqual(saved, { status: "processed", payload: null, completed: true });
  return id;
}
function provider(event: any, guest: any, secret: keyof typeof secrets = "LUMA_WEBHOOK_SECRET") {
  const reads: string[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const request = new URL(String(input));
    assert.equal(
      init.method || "GET",
      "GET",
      "Webhook projection must not send invitations or other provider mutations",
    );
    assert.equal(new Headers(init.headers).get("x-luma-api-key"), apiKeys[secret]);
    assert.equal(request.searchParams.get("event_id"), event.id);
    reads.push(request.pathname);
    if (request.pathname === "/v1/events/get") return Response.json(event);
    if (request.pathname === "/v1/events/guests/get") {
      assert.equal(request.searchParams.get("id"), guest.id);
      return Response.json(guest);
    }
    throw Error("Only notified-resource reads are permitted");
  }) as typeof fetch;
  return reads;
}
async function savedGuest(eventId: string) {
  const table = mode === "human" ? "guestbook_event_guests" : "luma_event_guests";
  return (
    await db.query(
      `SELECT person_id,status,checked_in_at,registration_answers,raw FROM ${table} WHERE event_id=$1`,
      [eventId],
    )
  ).rows;
}
before(async () => {
  originalFetch = globalThis.fetch;
  await db.connect();
  assert.equal(
    (await db.query("SHOW data_directory")).rows[0].data_directory,
    process.env.WEBHOOK_TEST_DATA_DIRECTORY,
  );
  Object.assign(process.env, secrets, {
    LUMA_API_KEY: apiKeys.LUMA_WEBHOOK_SECRET,
    LUMA_API_KEY_2: apiKeys.LUMA_WEBHOOK_SECRET_2,
    LUMA_WEBHOOK_CALENDAR_ID: "cal-synthetic-primary",
    LUMA_WEBHOOK_CALENDAR_ID_2: "cal-synthetic-secondary",
  });
  const [identity] = await sourcePrisma().$queryRaw<
    Array<{ schema: string; principal: string }>
  >`SELECT current_schema() AS schema,current_user::text AS principal`;
  assert.equal(identity.schema, namespace);
  if (namespace === "guestbook") {
    assert.equal(identity.principal, "guestbook_runtime");
    assert.equal(
      (
        await db.query(
          "SELECT has_table_privilege('guestbook_runtime','public.luma_people','SELECT') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    // Startup schema options must survive session reset, including raw SQL paths.
    await sourcePrisma().$executeRawUnsafe("RESET ALL");
    const [reset] = await sourcePrisma().$queryRaw<
      Array<{ schema: string }>
    >`SELECT current_schema() AS schema`;
    assert.equal(reset.schema, "guestbook");
  }
});
beforeEach(async () => {
  globalThis.fetch = (async () => {
    throw Error("Unexpected provider request");
  }) as typeof fetch;
  await db.query("DELETE FROM luma_webhook_deliveries");
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (namespace === "guestbook") {
    assert.equal(
      (await db.query("SELECT COUNT(*)::int AS count FROM public.luma_webhook_deliveries")).rows[0]
        .count,
      0,
    );
    assert.equal(
      (await db.query("SELECT COUNT(*)::int AS count FROM public.luma_people")).rows[0].count,
      0,
    );
  }
  await Promise.all([db.end(), disconnectDatabaseClients()]);
});

test("all eight supported types accept signed envelopes durably", async () => {
  const event = eventFixture(),
    guest = guestFixture(event);
  for (const type of LUMA_WEBHOOK_TYPES) {
    const data = type.startsWith("guest.")
      ? guest
      : type === "calendar.person.unsubscribed"
        ? { email: "subscriber@example.test" }
        : event;
    const response = await POST(signed({ type, actor: { type: "system" }, data }));
    assert.equal(response.status, 202, type);
  }
  assert.equal(
    (
      await db.query(
        "SELECT COUNT(*)::int AS count FROM luma_webhook_deliveries WHERE status='queued' AND payload IS NOT NULL",
      )
    ).rows[0].count,
    8,
  );
});

test("bad signatures, stale/future timestamps, malformed bodies and oversized bodies never queue", async () => {
  const event = eventFixture(),
    payload = { type: "event.updated", data: event };
  const cases = [
    { request: signed(payload, { signature: "0".repeat(64) }), status: 401 },
    {
      request: signed(payload, { timestamp: String(Math.floor(Date.now() / 1000) - 7200) }),
      status: 401,
    },
    {
      request: signed(payload, { timestamp: String(Math.floor(Date.now() / 1000) + 7200) }),
      status: 401,
    },
    { request: signed(payload, { body: "{" }), status: 400 },
    { request: signed([]), status: 400 },
    {
      request: signed({ type: "guest.updated", data: { ...guestFixture(event), user_id: null } }),
      status: 400,
    },
    { request: signed({ type: "event.updated", data: { id: "../invalid" } }), status: 400 },
    { request: signed(payload, { id: "invalid id" }), status: 400 },
    { request: signed(payload, { body: "x".repeat(1_000_001) }), status: 413 },
  ];
  for (const { request, status } of cases) assert.equal((await POST(request)).status, status);
  assert.equal(
    (await db.query("SELECT COUNT(*)::int AS count FROM luma_webhook_deliveries")).rows[0].count,
    0,
  );
});

test("unrelated signed events and external calendar entries are acknowledged without writes", async () => {
  for (const type of [
    "ticket.registered",
    "calendar.person.subscribed",
    "calendar.event.submitted",
    "unknown.example",
  ]) {
    const response = await POST(signed({ type, data: {} }));
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as any).ignored, true);
  }
  const response = await POST(
    signed({ type: "calendar.event.added", data: { id: "evt-external", platform: "external" } }),
  );
  assert.equal(((await response.json()) as any).ignored, true);
  assert.equal(
    (await db.query("SELECT COUNT(*)::int AS count FROM luma_webhook_deliveries")).rows[0].count,
    0,
  );
});

for (const [approval, expected] of [
  ["approved", "going"],
  ["pending_approval", "registered"],
  ["invited", "invited"],
  ["declined", "declined"],
  ["waitlist", "waitlisted"],
  ["session", "going"],
]) {
  test(`guest.registered projects current ${approval} state into ${mode} guests`, async () => {
    const event = eventFixture(),
      guest = { ...guestFixture(event), approval_status: approval };
    provider(event, guest);
    await project({ type: "guest.registered", data: { ...guest, approval_status: "declined" } });
    const saved = await savedGuest(event.id);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, expected);
    if (mode === "human") {
      const identity = (
        await db.query("SELECT person_id FROM guestbook_account_identities WHERE account_id=$1", [
          guest.user_id,
        ])
      ).rows[0];
      assert.notEqual(identity.person_id, guest.user_id);
      assert.equal(saved[0].person_id, identity.person_id);
    }
  });
}

test("check-in, un-check-in, changed answers and re-registration follow current state and preserve notes", async () => {
  const event = eventFixture(),
    guest: any = guestFixture(event);
  guest.event_tickets = [{ checked_in_at: new Date().toISOString() }];
  guest.registration_answers = [
    {
      question_id: "q-interests",
      question_type: "multi-select",
      label: "Interests",
      value: ["Hardware", "Research"],
    },
  ];
  provider(event, guest);
  const delivery = { type: "guest.updated", data: { ...guest, event_tickets: [] } };
  await project(delivery);
  let saved = (await savedGuest(event.id))[0];
  assert.equal(saved.status, "checked_in");
  assert.ok(saved.checked_in_at);
  assert.ok(saved.registration_answers.some((a: any) => a.values?.includes("Hardware")));
  const notes = mode === "human" ? "guestbook_comments" : "guest_comments";
  await db.query(
    `INSERT INTO ${notes}(person_id,body,author) VALUES($1,'Synthetic saved note','test')`,
    [saved.person_id],
  );
  guest.event_tickets = [];
  guest.registration_answers = [
    {
      question_id: "q-interests",
      question_type: "multi-select",
      label: "Interests",
      value: ["Software"],
    },
  ];
  await project(delivery);
  saved = (await savedGuest(event.id))[0];
  assert.equal(saved.status, "going");
  assert.equal(saved.checked_in_at, null);
  assert.ok(saved.registration_answers.some((a: any) => a.values?.includes("Software")));
  assert.equal(
    saved.registration_answers.some((a: any) => a.values?.includes("Hardware")),
    false,
  );
  guest.approval_status = "declined";
  await project(delivery);
  assert.equal((await savedGuest(event.id))[0].status, "declined");
  guest.approval_status = "approved";
  await project({ type: "guest.registered", data: guest });
  assert.equal((await savedGuest(event.id)).length, 1);
  assert.equal((await savedGuest(event.id))[0].status, "going");
  assert.equal(
    (
      await db.query(`SELECT COUNT(*)::int AS count FROM ${notes} WHERE person_id=$1`, [
        saved.person_id,
      ])
    ).rows[0].count,
    1,
  );
});

test("refunds project current registration and cumulative ticket refund evidence", async () => {
  const event = eventFixture(),
    guest: any = {
      ...guestFixture(event),
      approval_status: "declined",
      event_ticket_orders: [{ id: "order-synthetic", amount_refunded: 1500, currency: "usd" }],
    };
  provider(event, guest);
  await project({
    type: "guest.refunded",
    data: { ...guest, approval_status: "approved", refund: { amount: 500, currency: "usd" } },
  });
  const saved = (await savedGuest(event.id))[0];
  assert.equal(saved.status, "declined");
  assert.equal(saved.raw.event_ticket_orders[0].amount_refunded, 1500);
});

for (const type of ["event.created", "event.updated", "calendar.event.added"]) {
  test(`${type} refreshes current event details without scanning guests`, async () => {
    const event = { ...eventFixture(), name: "Current synthetic title", max_capacity: 80 };
    const reads = provider(event, null);
    await project({ type, data: { ...event, name: "Old synthetic title", max_capacity: 10 } });
    const saved = (
      await db.query("SELECT title,capacity FROM luma_events WHERE event_id=$1", [event.id])
    ).rows[0];
    assert.deepEqual(saved, { title: event.name, capacity: 80 });
    assert.deepEqual(reads, ["/v1/events/get"]);
  });
}

test("cancellation retains guest history and cannot be reversed by delayed guest or event deliveries", async () => {
  const event = eventFixture(),
    guest = guestFixture(event);
  const reads = provider(event, guest);
  await project({ type: "guest.registered", data: guest });
  const before = reads.length;
  await project({ type: "event.canceled", data: event });
  await project({ type: "guest.updated", data: guest });
  await project({ type: "event.updated", data: event });
  assert.equal(reads.length, before);
  assert.equal(
    (await db.query("SELECT catalog_active FROM luma_events WHERE event_id=$1", [event.id])).rows[0]
      .catalog_active,
    false,
  );
  assert.equal((await savedGuest(event.id)).length, 1);
});

test("secondary signing key selects its paired provider credential and calendar opt-out scope", async () => {
  const event = eventFixture(),
    guest = guestFixture(event);
  provider(event, guest, "LUMA_WEBHOOK_SECRET_2");
  const payload = { type: "guest.updated", data: guest };
  const id = await project(payload, "LUMA_WEBHOOK_SECRET_2");
  const duplicate = await POST(signed(payload, { id, secret: "LUMA_WEBHOOK_SECRET_2" }));
  assert.equal(((await duplicate.json()) as any).duplicate, true);
  assert.equal(await claimQueuedWebhook(), null);
  assert.equal((await savedGuest(event.id)).length, 1);
  globalThis.fetch = (async () => {
    throw Error("Opt-outs must not fetch or send provider data");
  }) as typeof fetch;
  await project(
    {
      type: "calendar.person.unsubscribed",
      data: { email: "  Subscriber@Example.Test ", calendar_id: "cal-forged" },
    },
    "LUMA_WEBHOOK_SECRET_2",
  );
  const saved = await db.query(
    'SELECT "calendarId","emailLower" FROM luma_calendar_opt_outs WHERE "emailLower"=$1',
    ["subscriber@example.test"],
  );
  assert.deepEqual(saved.rows, [
    { calendarId: "cal-synthetic-secondary", emailLower: "subscriber@example.test" },
  ]);
  delete process.env.LUMA_WEBHOOK_CALENDAR_ID_2;
  try {
    assert.equal(
      (
        await POST(
          signed(
            { type: "calendar.person.unsubscribed", data: { email: "other@example.test" } },
            { secret: "LUMA_WEBHOOK_SECRET_2" },
          ),
        )
      ).status,
      503,
    );
    assert.equal(await claimQueuedWebhook(), null);
  } finally {
    process.env.LUMA_WEBHOOK_CALENDAR_ID_2 = "cal-synthetic-secondary";
  }
});

test("provider rate limits retain durable payloads, honor retry-after and recover without duplicate guests", async () => {
  const event = eventFixture(),
    guest = guestFixture(event);
  assert.equal((await POST(signed({ type: "guest.updated", data: guest }))).status, 202);
  const row = (await claimQueuedWebhook())!;
  globalThis.fetch = (async () =>
    new Response(null, { status: 429, headers: { "retry-after": "120" } })) as typeof fetch;
  let failed: any;
  try {
    await processQueuedWebhook(row);
  } catch (error) {
    failed = error;
  }
  assert.equal(failed?.code, "LUMA_HTTP_429");
  await failQueuedWebhook(row, failed.code, failed.retryAfter);
  const pending = (
    await db.query(
      "SELECT status,payload IS NOT NULL AS retained,EXTRACT(EPOCH FROM(next_attempt_at-NOW())) AS delay FROM luma_webhook_deliveries WHERE webhook_id=$1",
      [row.webhook_id],
    )
  ).rows[0];
  assert.equal(pending.status, "retry");
  assert.equal(pending.retained, true);
  assert.ok(Number(pending.delay) > 110);
  assert.equal(await claimQueuedWebhook(), null);
  await db.query("UPDATE luma_webhook_deliveries SET next_attempt_at=NOW() WHERE webhook_id=$1", [
    row.webhook_id,
  ]);
  const retry = (await claimQueuedWebhook())!;
  assert.equal(retry.attempts, 2);
  provider(event, guest);
  await processQueuedWebhook(retry);
  await completeQueuedWebhook(retry);
  assert.equal((await savedGuest(event.id)).length, 1);
});

for (const resource of ["event", "guest"]) {
  test(`mismatched ${resource} identity stays retryable without writing another resource`, async () => {
    const event = eventFixture(),
      guest = guestFixture(event);
    assert.equal((await POST(signed({ type: "guest.updated", data: guest }))).status, 202);
    const row = (await claimQueuedWebhook())!;
    provider(
      resource === "event" ? { ...event, id: "evt-wrong-synthetic" } : event,
      resource === "guest" ? { ...guest, id: "gst-wrong-synthetic" } : guest,
    );
    // This fixture deliberately returns a different identity, despite the correct requested URL.
    globalThis.fetch = (async (input: any) =>
      new URL(String(input)).pathname === "/v1/events/get"
        ? Response.json(resource === "event" ? { ...event, id: "evt-wrong-synthetic" } : event)
        : Response.json({ ...guest, id: "gst-wrong-synthetic" })) as typeof fetch;
    await assert.rejects(
      processQueuedWebhook(row),
      (error: any) => error.code === `${resource.toUpperCase()}_ID_MISMATCH`,
    );
    assert.equal((await savedGuest(event.id)).length, 0);
  });
}
