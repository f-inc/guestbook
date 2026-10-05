import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptTrackingSession,
  decryptTrackingSession,
} from "./tracking-session";
const env = { GUESTBOOK_KEY: "test-workspace-secret" };
test("saved tracking sessions are randomized, encrypted, and recoverable by workers", () => {
  const token = "test-luma-session";
  const a = encryptTrackingSession(token, env),
    b = encryptTrackingSession(token, env);
  assert.notEqual(a, b);
  assert.ok(!a.includes(token));
  assert.equal(decryptTrackingSession(a, env), token);
});
test("tampering and mismatched encryption keys cannot recover a saved session", () => {
  const encrypted = encryptTrackingSession("test-luma-session", env);
  const parts = encrypted.split(".");
  const ciphertext = Buffer.from(parts[3], "base64");
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString("base64");
  assert.throws(() => decryptTrackingSession(parts.join("."), env));
  assert.throws(() =>
    decryptTrackingSession(encrypted, { GUESTBOOK_KEY: "different" }),
  );
});
test("dedicated tracking secret takes precedence over the workspace login key", () => {
  const original = { ...env, LUMA_TRACKING_ENCRYPTION_KEY: "dedicated-secret" };
  const encrypted = encryptTrackingSession("test-luma-session", original);
  assert.equal(
    decryptTrackingSession(encrypted, {
      ...original,
      GUESTBOOK_KEY: "rotated-login",
    }),
    "test-luma-session",
  );
});
