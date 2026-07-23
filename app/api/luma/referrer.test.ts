import assert from "node:assert/strict";
import test from "node:test";
import { extractLumaReferrer } from "./referrer";

test("extracts Luma's private opened_from referrer", () => {
  assert.deepEqual(extractLumaReferrer({
    opened_from: {
      name: "Founders, Inc. Events",
      source: "calendar",
      url: "/fdotinc?k=c",
      avatar_url: "https://images.lumacdn.com/calendars/founders.png",
      tint_color: "#101010",
    },
  }), {
    name: "Founders, Inc. Events",
    email: "",
    url: "https://luma.com/fdotinc?k=c",
    source: "calendar",
    avatarUrl: "https://images.lumacdn.com/calendars/founders.png",
    tintColor: "#101010",
  });
});

test("preserves public guest referrer fallbacks", () => {
  assert.deepEqual(extractLumaReferrer({
    referred_by: { name: "Ada", email: "ada@example.com" },
    referral_url: "https://example.com/invite",
    utm_source: "newsletter",
  }), {
    name: "Ada",
    email: "ada@example.com",
    url: "https://example.com/invite",
    source: "newsletter",
    avatarUrl: "",
    tintColor: "",
  });
});

test("returns null when no referrer data exists", () => {
  assert.equal(extractLumaReferrer({}), null);
});
