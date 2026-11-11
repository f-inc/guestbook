import assert from "node:assert/strict";
import test from "node:test";
import { lumaConnectionStatus } from "./connection-status";
import { GET } from "./connection/route";

test("missing server sessions are explicit and make no Luma requests", async () => {
  const result = await lumaConnectionStatus({
    environment: { LUMA_API_KEY: "calendar-secret" },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(result.apiKeyCount, 1);
  assert.deepEqual(result.sessions, []);
  assert.ok(result.checkedAt);
  assert.ok(!JSON.stringify(result).includes("calendar-secret"));
});

test("probes each distinct session once, authenticates safely, and limits the event read", async () => {
  const calls: string[] = [];
  const result = await lumaConnectionStatus({
    environment: { LUMA_SESSION_TOKEN: "session-secret", LUMA_SESSION_TOKEN_2: "session-secret" },
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      const url = new URL(String(input));
      assert.equal(url.pathname, "/home/get-events");
      assert.equal(url.searchParams.get("pagination_limit"), "1");
      assert.equal(url.searchParams.get("period"), "future");
      assert.equal(new Headers(init?.headers).get("cookie"), "luma.auth-session-key=session-secret");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      return Response.json({ entries: [] });
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.sessions, [{ name: "LUMA_SESSION_TOKEN", status: "connected" }]);
  assert.ok(!JSON.stringify(result).includes("session-secret"));
});

test("distinguishes rejection from outages and malformed successful responses", async () => {
  for (const [status, expected] of [[400, "invalid"], [401, "invalid"], [403, "invalid"], [429, "unavailable"], [500, "unavailable"], [200, "unavailable"]] as const) {
    const result = await lumaConnectionStatus({
      environment: { LUMA_SESSION_TOKEN: "secret" },
      fetchImpl: async () => Response.json({ error: "secret" }, { status }),
    });
    assert.equal(result.sessions[0].status, expected);
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("network failures do not leak credential-bearing errors", async () => {
  const result = await lumaConnectionStatus({
    environment: { LUMA_SESSION_TOKEN: "secret" },
    fetchImpl: async () => { throw new Error("secret"); },
  });
  assert.equal(result.sessions[0].status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("connection endpoint requires Guestbook authorization and disables caching", async () => {
  const previous = process.env.GUESTBOOK_KEY;
  process.env.GUESTBOOK_KEY = "expected-key";
  try {
    const response = await GET(new Request("https://guestbook.example/api/luma/connection"));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.json() as { sessions?: unknown }).sessions, undefined);
  } finally {
    if (previous === undefined) delete process.env.GUESTBOOK_KEY;
    else process.env.GUESTBOOK_KEY = previous;
  }
});
