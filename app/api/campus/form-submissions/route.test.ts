import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "./route";

test("Campus submissions require Guestbook auth and keep the Campus key server-side", async (t) => {
  const previous = { key: process.env.CAMPUS_API_KEY, url: process.env.CAMPUS_API_URL, guest: process.env.GUESTBOOK_KEY };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["CAMPUS_API_KEY", previous.key], ["CAMPUS_API_URL", previous.url], ["GUESTBOOK_KEY", previous.guest]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  });
  process.env.GUESTBOOK_KEY = "guest-test";
  process.env.CAMPUS_API_KEY = "campus-secret";
  process.env.CAMPUS_API_URL = "https://campus.test";
  let calls = 0;
  let providerStatus = 200;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://campus.test/api/integrations/form-submissions?formKey=guest-confirmation&limit=20");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer campus-secret");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json(providerStatus === 200 ? { data: [], pagination: { nextOffset: null } } : { secret: "do not expose" }, { status: providerStatus });
  };
  const url = "http://guestbook.test/api/campus/form-submissions?formKey=guest-confirmation&limit=20";
  assert.equal((await GET(new Request(url))).status, 401);
  assert.equal(calls, 0);
  const request = () => new Request(url, { headers: { "x-guestbook-key": "guest-test" } });
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { data: [], pagination: { nextOffset: null } });
  providerStatus = 403;
  const denied = await GET(request());
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Campus API key requires form-submissions.read." });
  delete process.env.CAMPUS_API_KEY;
  assert.equal((await GET(request())).status, 503);
});

test("Campus proxy rejects invalid queries, invalid origins, and challenge pages without exposing upstream content", async (t) => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; for (const name of ["GUESTBOOK_KEY", "CAMPUS_API_KEY", "CAMPUS_API_URL"]) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } });
  process.env.GUESTBOOK_KEY = "test-guest";
  process.env.CAMPUS_API_KEY = "test-secret";
  process.env.CAMPUS_API_URL = "https://campus.test";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("private challenge content", { status: 403, headers: { "content-type": "text/html" } }); };
  const request = (query: string) => new Request(`http://guestbook.test/api/campus/form-submissions?${query}`, { headers: { cookie: "guestbook_key=test-guest" } });
  for (const query of ["formKey=a&formKey=b", "unknown=value"]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
  const challenge = await GET(request("limit=1"));
  assert.equal(challenge.status, 502);
  assert.ok(!(await challenge.text()).includes("private challenge content"));
  process.env.CAMPUS_API_URL = "https://campus.test/path";
  assert.equal((await GET(request("limit=1"))).status, 503);
  process.env.CAMPUS_API_URL = "https://campus.test";
  globalThis.fetch = async () => { throw new Error("test-secret upstream detail"); };
  const failed = await GET(request("limit=1"));
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes("test-secret"));
});

test("full-field search finds nested answers across pages and preserves the next cursor", async (t) => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of ["GUESTBOOK_KEY", "CAMPUS_API_KEY", "CAMPUS_API_URL"]) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  });
  process.env.GUESTBOOK_KEY = "test-guest";
  process.env.CAMPUS_API_KEY = "test-secret";
  process.env.CAMPUS_API_URL = "https://campus.test";
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.has("q"), false);
    assert.equal(url.searchParams.has("email"), false);
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(offset === 0
      ? { data: [{ answers: { companyName: "Other" } }], pagination: { nextOffset: 1 } }
      : { data: [{ name: "Alex", email: "alex@example.test", answers: { custom: [{ equipment: "Projector", count: 80, enabled: false }] } }], pagination: { nextOffset: 2 } });
  };
  const request = (q: string) => new Request(`http://guestbook.test/api/campus/form-submissions?formKey=event-request&limit=1&q=${encodeURIComponent(q)}`, { headers: { "x-guestbook-key": "test-guest" } });
  for (const q of ["PROJECTOR", "Alex 80", "example.test", "false"]) {
    const response = await GET(request(q));
    assert.equal(response.status, 200);
    const body = await response.json() as { data: unknown[]; pagination: { nextOffset: number } };
    assert.equal(body.data.length, 1);
    assert.equal(body.pagination.nextOffset, 2);
  }
  assert.equal(calls, 8);
  assert.equal((await GET(new Request("http://guestbook.test/api/campus/form-submissions?q=test&offset=-1", { headers: { "x-guestbook-key": "test-guest" } }))).status, 400);
});

test("sparse searches remain bounded and expose a continuation cursor", async (t) => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of ["GUESTBOOK_KEY", "CAMPUS_API_KEY", "CAMPUS_API_URL"]) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  });
  process.env.GUESTBOOK_KEY = "test-guest";
  process.env.CAMPUS_API_KEY = "test-secret";
  process.env.CAMPUS_API_URL = "https://campus.test";
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    return Response.json({ data: [{ answers: { companyName: "Other" } }], pagination: { nextOffset: offset + 1 } });
  };
  const response = await GET(new Request("http://guestbook.test/api/campus/form-submissions?formKey=event-request&q=unmatched", { headers: { "x-guestbook-key": "test-guest" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [], pagination: { limit: 25, offset: 0, nextOffset: 20 } });
  assert.equal(calls, 20);
});
