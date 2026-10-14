import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "./route";

test("company icons authenticate and fall back from default favicon to LinkedIn", async t => {
  const fetchOriginal = globalThis.fetch;
  const key = process.env.GUESTBOOK_KEY;
  process.env.GUESTBOOK_KEY = "test-key";
  t.after(() => { globalThis.fetch = fetchOriginal; if (key === undefined) delete process.env.GUESTBOOK_KEY; else process.env.GUESTBOOK_KEY = key; });
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    const url = new URL(String(input));
    if (url.hostname === "www.google.com") return new Response("default", { headers: { "content-type": "image/png" } });
    if (url.hostname === "www.linkedin.com") return new Response('<meta content="https://media.licdn.com/company.png" property="og:image">', { headers: { "content-type": "text/html" } });
    if (url.hostname === "media.licdn.com") return new Response("company-logo", { headers: { "content-type": "image/png" } });
    throw new Error("Unexpected host");
  };
  const url = "http://guestbook.test/api/campus/company-icon?website=https://example.com&linkedin=https://www.linkedin.com/company/example";
  assert.equal((await GET(new Request(url))).status, 401);
  assert.equal(calls, 0);
  const result = await GET(new Request(url, { headers: { cookie: "guestbook_key=test-key" } }));
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "company-logo");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  calls = 0;
  assert.equal((await GET(new Request("http://guestbook.test/api/campus/company-icon?linkedin=https://localhost/company/example", { headers: { cookie: "guestbook_key=test-key" } }))).status, 404);
  assert.equal(calls, 0);
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  assert.equal((await GET(new Request(url, { headers: { cookie: "guestbook_key=test-key" } }))).status, 404);
});
