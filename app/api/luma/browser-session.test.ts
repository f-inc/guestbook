import assert from "node:assert/strict";
import test from "node:test";
import { addBrowserLumaSession, LUMA_SESSION_HEADER, normalizeBrowserLumaSession } from "../../luma-session";
import { browserLumaSession, withBrowserLumaSession } from "./browser-session";
import { knownLumaEventSessionToken, lumaSessionTokens, rememberLumaEventSessionToken } from "./api-keys";
import { createLumaClient } from "./luma-client";
import { lumaConnectionStatus } from "./connection-status";
import { GET as connectionGET } from "./connection/route";

const request = (token: string) => new Request("https://guestbook.example/api/luma", { headers: { [LUMA_SESSION_HEADER]: token } });

test("browser tokens are sent only to same-origin Luma endpoints and explicit replacements win", () => {
  for (const path of ["/api/luma", "/api/luma/connection", "/api/luma/sync"]) {
    const headers = new Headers();
    addBrowserLumaSession(headers, path, "https://guestbook.example", "saved-token");
    assert.equal(headers.get(LUMA_SESSION_HEADER), "saved-token");
  }
  for (const path of ["https://elsewhere.example/api/luma", "/api/search/people", "/api/luma-other", "//elsewhere.example/api/luma"]) {
    const headers = new Headers();
    addBrowserLumaSession(headers, path, "https://guestbook.example", "saved-token");
    assert.equal(headers.has(LUMA_SESSION_HEADER), false);
  }
  const replacement = new Headers({ [LUMA_SESSION_HEADER]: "new-token" });
  addBrowserLumaSession(replacement, "/api/luma/connection", "https://guestbook.example", "old-token");
  assert.equal(replacement.get(LUMA_SESSION_HEADER), "new-token");
});

test("concurrent requests isolate tokens, credential routing, and caches", async () => {
  await Promise.all(["browser-A", "browser-B"].map((token) => withBrowserLumaSession(request(token), async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const credentials = lumaSessionTokens();
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].value, token);
    rememberLumaEventSessionToken("shared-event", credentials[0]);
    browserLumaSession()!.cache.set("test", token);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(knownLumaEventSessionToken("shared-event")?.value, token);
    assert.equal(browserLumaSession()!.cache.get("test"), token);
    return Response.json({ ok: true });
  })));
  assert.equal(browserLumaSession(), undefined);
  assert.equal(knownLumaEventSessionToken("shared-event"), null);
});

test("event discovery and connection checks use the saved browser token", async () => {
  const previous = process.env.LUMA_SESSION_TOKEN;
  process.env.LUMA_SESSION_TOKEN = "expired-server-token";
  try {
    await withBrowserLumaSession(request("browser-token"), async () => {
      const cookies: string[] = [];
      const client = createLumaClient({
        logger: async () => {},
        fetchImpl: async (url, init) => {
          assert.equal(new URL(String(url)).pathname, "/home/get-events");
          cookies.push(new Headers(init?.headers).get("cookie") || "");
          return Response.json({ entries: [{ manager_info: {}, event: { api_id: "evt-personal", name: "Personal event" } }] });
        },
      });
      const catalog = await client.fetchSessionEventCatalog({ requestId: "test", sessionToken: lumaSessionTokens()[0], maxEntries: 2, maxPages: 1, pageSize: 1 });
      assert.equal(catalog.entries[0].id, "evt-personal");
      assert.ok(cookies.every((cookie) => cookie === "luma.auth-session-key=browser-token"));
      const status = await lumaConnectionStatus({ fetchImpl: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("cookie"), "luma.auth-session-key=browser-token");
        return Response.json({ entries: [] });
      } });
      assert.deepEqual(status.sessions, [{ name: "browser-session", status: "connected" }]);
      assert.ok(!JSON.stringify(status).includes("browser-token"));
      return Response.json({ ok: true });
    });
    assert.equal(lumaSessionTokens()[0].value, "expired-server-token");
  } finally {
    if (previous === undefined) delete process.env.LUMA_SESSION_TOKEN;
    else process.env.LUMA_SESSION_TOKEN = previous;
  }
});

test("invalid browser credentials fail without running the handler or echoing the secret", async () => {
  const token = "a".repeat(8193);
  const response = await withBrowserLumaSession(request(token), async () => { throw new Error("must not run"); });
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes(token));
  assert.equal(normalizeBrowserLumaSession("token with spaces"), "");
});

test("authenticated connection endpoint validates a replacement without persisting or echoing it", async () => {
  const previousKey = process.env.GUESTBOOK_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GUESTBOOK_KEY = "workspace-test-key";
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("cookie"), "luma.auth-session-key=replacement-token");
    return Response.json({ entries: [] });
  };
  try {
    const response = await connectionGET(new Request("https://guestbook.example/api/luma/connection", {
      headers: { "x-guestbook-key": "workspace-test-key", [LUMA_SESSION_HEADER]: "replacement-token" },
    }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes("replacement-token"));
    assert.deepEqual(JSON.parse(text).sessions, [{ name: "browser-session", status: "connected" }]);
    assert.equal(browserLumaSession(), undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GUESTBOOK_KEY;
    else process.env.GUESTBOOK_KEY = previousKey;
  }
});
