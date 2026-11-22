import assert from "node:assert/strict";
import test from "node:test";
import { clearLumaEventCredentialCache, lumaSessionTokens, rememberLumaEventCredential } from "./api-keys";
import { withBrowserLumaSession } from "./browser-session";
import { createLumaClient } from "./luma-client";

const options = { requestId: "status-test", eventId: "evt-status-test", guestId: "gst-example", status: "approved", sendEmail: false, message: null };
const browser = (token = "test-browser-session") => new Request("https://guestbook.example/api/luma", { headers: { "x-luma-session-token": token } });

async function isolated(run: () => Promise<void>) {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (/^LUMA_(API_KEY|SESSION_TOKEN)(?:_\d+)?$/.test(name)) delete process.env[name];
  }
  delete process.env.DB_URL;
  process.env.LUMA_API_KEY = "mock-api-key";
  clearLumaEventCredentialCache();
  try { await run(); } finally { clearLumaEventCredentialCache(); process.env = saved; }
}

test("denied API writes fall back to the browser session and remember it across requests", async () => isolated(async () => {
  const paths: string[] = [];
  const logs: unknown[] = [];
  const client = createLumaClient({ logger: async (_id, _event, details) => { logs.push(details); }, fetchImpl: async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const headers = new Headers(init?.headers);
    if (path.startsWith("/v1/")) {
      assert.equal(headers.get("x-luma-api-key"), "mock-api-key");
      return Response.json({}, { status: 403 });
    }
    assert.equal(headers.get("cookie"), "luma.auth-session-key=test-browser-session");
    if (path === "/task/get-status") return Response.json({ status: "success" });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      event_api_id: options.eventId, rsvp_api_ids: [options.guestId], approval_status: "approved",
      suppress_email: true, custom_message: { type: "doc", content: [{ type: "paragraph" }] }, event_ticket_type_api_id: null,
    });
    return Response.json({ task_id: "task-example" });
  } });
  for (let i = 0; i < 2; i++) await withBrowserLumaSession(browser(), async () => {
    await client.updateEventGuestStatus(options);
    return Response.json({ ok: true });
  });
  assert.deepEqual(paths, ["/v1/events/guests/update-status", "/event/admin/update-guests-statuses", "/task/get-status", "/event/admin/update-guests-statuses", "/task/get-status"]);
  assert.ok(!JSON.stringify(logs).includes("test-browser-session"));
  assert.ok(!JSON.stringify(logs).includes("mock-api-key"));
}));

test("catalog session ownership and guest-read fallback both guide subsequent writes", async () => isolated(async () => {
  for (const discovery of ["catalog", "guests"]) {
    const paths: string[] = [];
    const client = createLumaClient({ logger: async () => {}, fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v1/events/guests/list") return Response.json({}, { status: 403 });
      return Response.json({ entries: [] });
    } });
    const request = browser(`discovery-${discovery}`);
    await withBrowserLumaSession(request, async () => {
      if (discovery === "catalog") rememberLumaEventCredential(options.eventId, { type: "session-token", value: lumaSessionTokens()[0] });
      else await client.fetchEventGuestsBounded({ requestId: "guests", eventId: options.eventId, pageSize: 1, maxPages: 1, maxEntries: 1 });
      return Response.json({ ok: true });
    });
    paths.length = 0;
    await withBrowserLumaSession(request, async () => {
      await client.updateEventGuestStatus(options);
      return Response.json({ ok: true });
    });
    assert.deepEqual(paths, ["/event/admin/update-guests-statuses"]);
  }
}));

test("working API keys stay preferred and another key is tried after access denial", async () => isolated(async () => {
  process.env.LUMA_API_KEY_2 = "mock-second-key";
  const keys: string[] = [];
  const client = createLumaClient({ logger: async () => {}, fetchImpl: async (_input, init) => {
    const key = new Headers(init?.headers).get("x-luma-api-key")!;
    keys.push(key);
    assert.deepEqual(JSON.parse(String(init?.body)), { event_id: options.eventId, guest_id: options.guestId, status: "approved", send_email: false, message: null });
    return key === "mock-api-key" ? Response.json({}, { status: 403 }) : Response.json({});
  } });
  await client.updateEventGuestStatus(options);
  await client.updateEventGuestStatus(options);
  assert.deepEqual(keys, ["mock-api-key", "mock-second-key", "mock-second-key"]);
}));

test("session-only writes preserve notifications, messages, statuses, and never request refunds", async () => isolated(async () => {
  delete process.env.LUMA_API_KEY;
  for (const status of ["approved", "waitlist", "declined"]) await withBrowserLumaSession(browser(`status-${status}`), async () => {
    const client = createLumaClient({ logger: async () => {}, fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.approval_status, status);
      assert.equal(body.suppress_email, false);
      assert.deepEqual(body.custom_message.content, [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "<example>" }] },
      ]);
      if (status !== "approved") assert.equal(body.should_refund, false);
      return Response.json({});
    } });
    await client.updateEventGuestStatus({ ...options, status, sendEmail: true, message: "Hello\n<example>" });
    return Response.json({ ok: true });
  });
}));

test("writes do not fall back after validation, server, network or task errors", async () => isolated(async () => {
  process.env.LUMA_RATE_LIMIT_MAX_RETRIES = "0";
  for (const status of [400, 429, 500]) {
    let calls = 0;
    const client = createLumaClient({ logger: async () => {}, fetchImpl: async () => { calls++; return Response.json({}, { status }); } });
    await assert.rejects(client.updateEventGuestStatus(options), { status });
    assert.equal(calls, 1);
  }
  for (const failure of ["network", "validation", "task-denied", "task-failure"]) await withBrowserLumaSession(browser(`failure-${failure}`), async () => {
    rememberLumaEventCredential(options.eventId, { type: "session-token", value: lumaSessionTokens()[0] });
    const paths: string[] = [];
    const client = createLumaClient({ logger: async () => {}, fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (failure === "network") throw new Error("connection closed");
      if (failure === "validation") return Response.json({}, { status: 400 });
      if (path === "/event/admin/update-guests-statuses") return Response.json({ task_id: "task-example" });
      return failure === "task-denied" ? Response.json({}, { status: 403 }) : Response.json({ status: "failure" });
    } });
    await assert.rejects(client.updateEventGuestStatus(options));
    assert.ok(paths.every((path) => !path.startsWith("/v1/")));
    assert.equal(paths.filter((path) => path === "/event/admin/update-guests-statuses").length, 1);
    return Response.json({ ok: true });
  });
}));

test("routing does not leak between browser identities or into server requests", async () => isolated(async () => {
  await withBrowserLumaSession(browser("private-routing-A"), async () => {
    rememberLumaEventCredential(options.eventId, { type: "session-token", value: lumaSessionTokens()[0] });
    return Response.json({ ok: true });
  });
  const paths: string[] = [];
  const client = createLumaClient({ logger: async () => {}, fetchImpl: async (input) => { paths.push(new URL(String(input)).pathname); return Response.json({}); } });
  await withBrowserLumaSession(browser("private-routing-B"), async () => {
    await client.updateEventGuestStatus(options);
    return Response.json({ ok: true });
  });
  await client.updateEventGuestStatus(options);
  assert.deepEqual(paths, ["/v1/events/guests/update-status", "/v1/events/guests/update-status"]);
}));

test("event routing stays separate and complete denial surfaces an error", async () => isolated(async () => {
  const paths: string[] = [];
  await withBrowserLumaSession(browser("per-event-routing"), async () => {
    rememberLumaEventCredential(options.eventId, { type: "session-token", value: lumaSessionTokens()[0] });
    const client = createLumaClient({ logger: async () => {}, fetchImpl: async (input) => { paths.push(new URL(String(input)).pathname); return Response.json({}); } });
    await client.updateEventGuestStatus(options);
    await client.updateEventGuestStatus({ ...options, eventId: "evt-other" });
    assert.deepEqual(paths, ["/event/admin/update-guests-statuses", "/v1/events/guests/update-status"]);
    paths.length = 0;
    const denied = createLumaClient({ logger: async () => {}, fetchImpl: async (input) => { paths.push(new URL(String(input)).pathname); return Response.json({}, { status: 403 }); } });
    await assert.rejects(denied.updateEventGuestStatus({ ...options, eventId: "evt-denied" }), { status: 403 });
    assert.deepEqual(paths, ["/v1/events/guests/update-status", "/event/admin/update-guests-statuses"]);
    return Response.json({ ok: true });
  });
}));

test("pending session tasks are polled without repeating the write", async () => isolated(async () => {
  delete process.env.LUMA_API_KEY;
  let writes = 0;
  let polls = 0;
  await withBrowserLumaSession(browser("pending-task-session"), async () => {
    const client = createLumaClient({ logger: async () => {}, fetchImpl: async (input, init) => {
      assert.ok(init?.signal);
      const url = new URL(String(input));
      if (url.pathname === "/event/admin/update-guests-statuses") {
        writes++;
        return Response.json({ task_id: "task-pending" });
      }
      assert.equal(url.searchParams.get("task_id"), "task-pending");
      return Response.json({ status: ++polls === 1 ? "pending" : "success" });
    } });
    await client.updateEventGuestStatus(options);
    assert.equal(writes, 1);
    assert.equal(polls, 2);
    return Response.json({ ok: true });
  });
}));

test("single and bulk routes accept browser-only credentials and still require write confirmation", async () => isolated(async () => {
  delete process.env.LUMA_API_KEY;
  process.env.GUESTBOOK_KEY = "test-workspace-key";
  process.env.GUESTBOOK_DEBUG_LOG_PATH = "/tmp/guestbook-status-routing-test.log";
  process.env.LUMA_BULK_STATUS_REQUEST_DELAY_MS = "0";
  const previousFetch = globalThis.fetch;
  const written: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/event/admin/update-guests-statuses");
    written.push(...JSON.parse(String(init?.body)).rsvp_api_ids);
    return Response.json({});
  };
  try {
    const { POST } = await import("./route");
    // Prisma's module initialization can load dotenv files. Disable database
    // access and remove configured credentials again before invoking any route.
    delete process.env.DB_URL;
    for (const name of Object.keys(process.env)) {
      if (/^LUMA_(API_KEY|SESSION_TOKEN)(?:_\d+)?$/.test(name)) delete process.env[name];
    }
    const send = (action: string, confirm: string) => POST(new Request("https://guestbook.example/api/luma", {
      method: "POST", headers: { "content-type": "application/json", "x-guestbook-key": "test-workspace-key", "x-luma-session-token": "route-test-session" },
      body: JSON.stringify({ action, confirm, eventId: "evt-route", guestId: "gst-single", guests: [{ guestId: "gst-bulk-one" }, { guestId: "gst-bulk-two" }], status: "going" }),
    }));
    assert.equal((await send("updateGuestStatus", "missing")).status, 400);
    assert.equal(written.length, 0);
    assert.equal((await send("updateGuestStatus", "CONFIRM_LUMA_WRITE")).status, 200);
    const bulk = await send("bulkUpdateGuestStatus", "CONFIRM_LUMA_WRITE");
    assert.equal(bulk.status, 200);
    const result = await bulk.json() as { updated: number };
    assert.equal(result.updated, 2);
    assert.deepEqual(written, ["gst-single", "gst-bulk-one", "gst-bulk-two"]);
  } finally { globalThis.fetch = previousFetch; }
}));
