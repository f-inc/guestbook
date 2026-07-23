import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitBackoffMs, retryAfterMs } from "./rate-limit-retry";

test("parses Retry-After seconds", () => {
  assert.equal(retryAfterMs("2.5"), 2_500);
});

test("parses Retry-After dates", () => {
  const now = Date.parse("2026-07-23T10:00:00.000Z");
  assert.equal(retryAfterMs("Thu, 23 Jul 2026 10:00:04 GMT", now), 4_000);
});

test("uses bounded exponential backoff without Retry-After", () => {
  assert.equal(rateLimitBackoffMs({ retryAfter: null, attempt: 0 }), 1_000);
  assert.equal(rateLimitBackoffMs({ retryAfter: null, attempt: 3 }), 8_000);
  assert.equal(rateLimitBackoffMs({ retryAfter: null, attempt: 10 }), 30_000);
});

test("caps an excessive Retry-After delay", () => {
  assert.equal(rateLimitBackoffMs({ retryAfter: "120", attempt: 0 }), 30_000);
});
