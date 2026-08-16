import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLumaEventCredentialCache,
  knownLumaEventApiKey,
  knownLumaEventCredential,
  lumaApiKeys,
  lumaEventCredentialCacheSize,
  lumaSessionTokens,
  mergeLumaEvents,
  rememberLumaEventApiKey,
  rememberLumaEventSessionToken,
} from "./api-keys";

test("discovers base and numbered Luma API keys in numeric order", () => {
  assert.deepEqual(
    lumaApiKeys({
      LUMA_API_KEY_10: "ten",
      LUMA_API_KEY_2: "two",
      LUMA_API_KEY: "base",
      LUMA_API_KEY_1: "one",
      LUMA_API_KEY_BAD: "ignored",
      LUMA_API_KEY_3: "  ",
    }).map(({ envName, value }) => ({ envName, value })),
    [
      { envName: "LUMA_API_KEY", value: "base" },
      { envName: "LUMA_API_KEY_1", value: "one" },
      { envName: "LUMA_API_KEY_2", value: "two" },
      { envName: "LUMA_API_KEY_10", value: "ten" },
    ],
  );
});

test("deduplicates repeated Luma API key values", () => {
  assert.deepEqual(
    lumaApiKeys({ LUMA_API_KEY: "same", LUMA_API_KEY_2: "same", LUMA_API_KEY_3: "other" })
      .map((key) => key.envName),
    ["LUMA_API_KEY", "LUMA_API_KEY_3"],
  );
});

test("discovers and deduplicates base and numbered Luma session tokens", () => {
  assert.deepEqual(
    lumaSessionTokens({
      LUMA_SESSION_TOKEN_10: "ten",
      LUMA_SESSION_TOKEN_2: "two",
      LUMA_SESSION_TOKEN: "base",
      LUMA_SESSION_TOKEN_3: "two",
      LUMA_SESSION_TOKEN_BAD: "ignored",
    }).map(({ envName, value }) => ({ envName, value })),
    [
      { envName: "LUMA_SESSION_TOKEN", value: "base" },
      { envName: "LUMA_SESSION_TOKEN_2", value: "two" },
      { envName: "LUMA_SESSION_TOKEN_10", value: "ten" },
    ],
  );
});

test("merges duplicate events and sorts the aggregate newest first", () => {
  const older = { id: "evt-old", start_at: "2026-01-01T00:00:00Z" };
  const newer = { id: "evt-new", start_at: "2026-02-01T00:00:00Z" };
  const duplicate = { id: "evt-old", start_at: "2027-01-01T00:00:00Z" };
  assert.deepEqual(mergeLumaEvents([[older], [newer, duplicate]]), [newer, older]);
});

test("prefers an API key over a session token and the lowest configured key order", () => {
  clearLumaEventCredentialCache();
  rememberLumaEventSessionToken("evt-one", { envName: "LUMA_SESSION_TOKEN", value: "session", order: 0 });
  rememberLumaEventApiKey("evt-one", { envName: "LUMA_API_KEY_2", value: "two", order: 2 });
  rememberLumaEventApiKey("evt-one", { envName: "LUMA_API_KEY", value: "base", order: 0 });
  assert.equal(knownLumaEventApiKey("evt-one", {
    LUMA_API_KEY: "base",
    LUMA_API_KEY_2: "two",
    LUMA_SESSION_TOKEN: "session",
  })?.envName, "LUMA_API_KEY");
});

test("bounds and expires the event credential cache", () => {
  clearLumaEventCredentialCache();
  const key = { envName: "LUMA_API_KEY", value: "base", order: 0 };
  for (let index = 0; index < 1_010; index += 1) rememberLumaEventApiKey(`evt-${index}`, key);
  assert.equal(lumaEventCredentialCacheSize(), 1_000);
  assert.equal(knownLumaEventCredential("evt-0", { LUMA_API_KEY: "base" }), null);

  clearLumaEventCredentialCache();
  rememberLumaEventApiKey("evt-expiring", key);
  assert.equal(knownLumaEventCredential("evt-expiring", { LUMA_API_KEY: "base" }, Date.now() + 7 * 60 * 60 * 1_000), null);
});
