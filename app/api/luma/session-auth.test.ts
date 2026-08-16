import assert from "node:assert/strict";
import test from "node:test";
import {
  GUESTBOOK_KEY_COOKIE,
  GUESTBOOK_KEY_HEADER,
  isGuestbookRequestAuthorized,
  LEGACY_SESSION_KEY_COOKIE,
  LEGACY_SESSION_KEY_HEADER,
} from "../session-auth";

const expectedKey = "test guestbook key";

test("authorizes the Guestbook key header", () => {
  const request = new Request("https://guestbook.example.com/api/luma", {
    headers: { [GUESTBOOK_KEY_HEADER]: expectedKey },
  });

  assert.equal(isGuestbookRequestAuthorized(request, expectedKey), true);
});

test("authorizes the same-site cookie used by protected image requests", () => {
  const request = new Request("https://guestbook.example.com/api/luma/avatar", {
    headers: { cookie: `${GUESTBOOK_KEY_COOKIE}=${encodeURIComponent(expectedKey)}` },
  });

  assert.equal(isGuestbookRequestAuthorized(request, expectedKey), true);
});

test("rejects missing and incorrect credentials", () => {
  const missing = new Request("https://guestbook.example.com/api/luma");
  const incorrect = new Request("https://guestbook.example.com/api/luma", {
    headers: { [GUESTBOOK_KEY_HEADER]: "wrong" },
  });

  assert.equal(isGuestbookRequestAuthorized(missing, expectedKey), false);
  assert.equal(isGuestbookRequestAuthorized(incorrect, expectedKey), false);
});

test("does not let a cookie override an incorrect explicit header", () => {
  const request = new Request("https://guestbook.example.com/api/luma", {
    headers: {
      [GUESTBOOK_KEY_HEADER]: "wrong",
      cookie: `${GUESTBOOK_KEY_COOKIE}=${encodeURIComponent(expectedKey)}`,
    },
  });

  assert.equal(isGuestbookRequestAuthorized(request, expectedKey), false);
});

test("temporarily accepts the legacy session header and cookie", () => {
  const headerRequest = new Request("https://guestbook.example.com/api/luma", {
    headers: { [LEGACY_SESSION_KEY_HEADER]: expectedKey },
  });
  const cookieRequest = new Request("https://guestbook.example.com/api/luma", {
    headers: { cookie: `${LEGACY_SESSION_KEY_COOKIE}=${encodeURIComponent(expectedKey)}` },
  });

  assert.equal(isGuestbookRequestAuthorized(headerRequest, expectedKey), true);
  assert.equal(isGuestbookRequestAuthorized(cookieRequest, expectedKey), true);
});
