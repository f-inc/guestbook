import assert from "node:assert/strict";
import { test } from "node:test";
import { readRequestsResponse } from "../../../requests/response";

test("Requests handles Cloudflare challenges and gateway HTML without exposing page content", async () => {
  for (const status of [200, 502, 503, 504]) {
    const response = new Response("<!DOCTYPE html><title>Private gateway details</title>", { status, headers: { "content-type": "text/html" } });
    await assert.rejects(readRequestsResponse(response), { message: "Requests are temporarily unavailable. Please try again in a few minutes." });
  }
  for (const headers of [{ "content-type": "text/html" }, { "cf-mitigated": "challenge" }]) {
    await assert.rejects(readRequestsResponse(new Response("private challenge", { status: 403, headers })), { message: "Access to requests was blocked. Reload the page and try again." });
  }
  await assert.rejects(readRequestsResponse(new Response("private Vercel checkpoint", { status: 429, headers: { "x-vercel-mitigated": "challenge" } })), { message: "Access to requests was blocked. Reload the page and try again." });
});

test("Requests preserves JSON results and API errors, and handles malformed JSON", async () => {
  const data = { data: [], pagination: { limit: 25, offset: 0, nextOffset: null } };
  assert.deepEqual(await readRequestsResponse(Response.json(data)), data);
  await assert.rejects(readRequestsResponse(Response.json({ error: "Campus form submissions are unavailable." }, { status: 502 })), { message: "Campus form submissions are unavailable." });
  for (const response of [Response.json(null), new Response("<html>private details</html>", { headers: { "content-type": "application/json" } }), Response.json({ error: { private: "details" } }, { status: 500 })]) {
    await assert.rejects(readRequestsResponse(response), { message: "Requests are temporarily unavailable. Please try again in a few minutes." });
  }
});
