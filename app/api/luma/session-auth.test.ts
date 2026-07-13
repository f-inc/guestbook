import assert from "node:assert/strict";
import test from "node:test";
import { isSessionRequestAuthorized, SESSION_KEY_COOKIE, SESSION_KEY_HEADER } from "../session-auth";

const expectedKey = "test guestbook key";

test("authorizes the session header", () => {
  const request = new Request("https://guestbook.example.com/api/luma", {
    headers: { [SESSION_KEY_HEADER]: expectedKey },
  });

  assert.equal(isSessionRequestAuthorized(request, expectedKey), true);
});

test("authorizes the same-site cookie used by protected image requests", () => {
  const request = new Request("https://guestbook.example.com/api/luma/avatar", {
    headers: { cookie: `${SESSION_KEY_COOKIE}=${encodeURIComponent(expectedKey)}` },
  });

  assert.equal(isSessionRequestAuthorized(request, expectedKey), true);
});

test("rejects missing and incorrect credentials", () => {
  const missing = new Request("https://guestbook.example.com/api/luma");
  const incorrect = new Request("https://guestbook.example.com/api/luma", {
    headers: { [SESSION_KEY_HEADER]: "wrong" },
  });

  assert.equal(isSessionRequestAuthorized(missing, expectedKey), false);
  assert.equal(isSessionRequestAuthorized(incorrect, expectedKey), false);
});

test("does not let a cookie override an incorrect explicit header", () => {
  const request = new Request("https://guestbook.example.com/api/luma", {
    headers: {
      [SESSION_KEY_HEADER]: "wrong",
      cookie: `${SESSION_KEY_COOKIE}=${encodeURIComponent(expectedKey)}`,
    },
  });

  assert.equal(isSessionRequestAuthorized(request, expectedKey), false);
});
