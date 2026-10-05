import assert from "node:assert/strict";
import test from "node:test";
import { clearLumaEventCredentialCache, rememberLumaEventApiKey } from "./api-keys";
import { createLumaClient } from "./luma-client";

const logger = async () => {};

test("reserves a bounded page budget for both future and past session events", async () => {
  const periods: string[] = [];
  const client = createLumaClient({
    logger,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const period = url.searchParams.get("period") || "";
      periods.push(period);
      const eventId = period === "future" ? "evt-future" : "evt-past";
      return Response.json({
        entries: [{ manager_info: {}, event: { id: eventId, start_at: period === "future" ? "2026-08-01" : "2026-01-01" } }],
        next_cursor: period === "future" ? "more-future-events" : null,
      });
    },
  });

  const result = await client.fetchSessionEventCatalog({
    requestId: "request-one",
    sessionToken: { envName: "LUMA_SESSION_TOKEN", value: "session", order: 0 },
    maxEntries: 10,
    maxPages: 1,
    pageSize: 25,
  });

  assert.deepEqual(periods, ["future", "past"]);
  assert.deepEqual(result.entries.map((event) => event.id), ["evt-future", "evt-past"]);
  assert.equal(result.truncated, true);
});

test("private requests identify configured credentials without logging token values", async () => {
  const logs: Array<Record<string, any>> = [];
  const client = createLumaClient({
    logger: async (_requestId, event, details = {}) => { logs.push({ event, details }); },
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await client.privateGet({
    requestId: "request-two",
    sessionToken: { envName: "LUMA_SESSION_TOKEN_2", value: "secret-token", order: 2 },
    path: "/event/admin/get",
    params: { event_api_id: "evt-one" },
    operation: "event ownership",
  });
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes("secret-token")), false);
  assert.equal(logs.some((entry) => entry.details.sessionTokenName === "LUMA_SESSION_TOKEN_2"), true);
});

async function withCredentials(run: () => Promise<void>) {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (/^LUMA_(API_KEY|SESSION_TOKEN)(?:_\d+)?$/.test(name)) delete process.env[name];
  process.env.LUMA_API_KEY = "api-secret";
  process.env.LUMA_SESSION_TOKEN = "session-secret";
  clearLumaEventCredentialCache();
  try { await run(); } finally { process.env = saved; clearLumaEventCredentialCache(); }
}

const guestOptions = { requestId: "guest-test", eventId: "evt-guest-test", pageSize: 1, maxEntries: 1, maxPages: 1 };

test("guest access falls back from public 403 and remembers the working session", async () => withCredentials(async () => {
  const paths: string[] = [];
  rememberLumaEventApiKey(guestOptions.eventId, { envName: "LUMA_API_KEY", value: "api-secret", order: 0 });
  const client = createLumaClient({ logger, fetchImpl: async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.searchParams.get("pagination_limit"), "1");
    return url.pathname.startsWith("/v1/") ? Response.json({}, { status: 403 }) : Response.json({ entries: [{ id: "guest" }], next_cursor: "more" });
  } });
  const result = await client.fetchEventGuestsBounded(guestOptions);
  assert.equal(result.entries.length, 1);
  assert.equal(result.truncated, true);
  await client.fetchEventGuestsBounded(guestOptions);
  assert.deepEqual(paths, ["/v1/events/guests/list", "/event/admin/get-guests", "/event/admin/get-guests"]);
}));

test("guest access tries another API key before sessions", async () => withCredentials(async () => {
  process.env.LUMA_API_KEY_2 = "second-secret";
  let calls = 0;
  const client = createLumaClient({ logger, fetchImpl: async (_input, init) => {
    calls++;
    const key = new Headers(init?.headers).get("x-luma-api-key");
    return key === "second-secret" ? Response.json({ entries: [] }) : Response.json({}, { status: 403 });
  } });
  assert.equal((await client.fetchEventGuestsBounded(guestOptions)).entries.length, 0);
  assert.equal(calls, 2);
}));

test("guest failures are surfaced when all credentials are denied; server errors do not trigger fallback", async () => withCredentials(async () => {
  for (const status of [403, 500]) {
    let calls = 0;
    const client = createLumaClient({ logger, fetchImpl: async () => { calls++; return Response.json({}, { status }); } });
    await assert.rejects(client.fetchEventGuestsBounded(guestOptions), { status });
    assert.equal(calls, status === 403 ? 2 : 1);
  }
}));
