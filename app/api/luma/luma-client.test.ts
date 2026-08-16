import assert from "node:assert/strict";
import test from "node:test";
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
