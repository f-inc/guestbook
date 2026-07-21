import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INVITE_MESSAGE_LENGTH, normalizeInviteMessage } from "../../invite-message";

test("normalizes one bulk invite message", () => {
  assert.equal(normalizeInviteMessage("  Join us next week.  "), "Join us next week.");
  assert.equal(normalizeInviteMessage("   "), null);
});

test("rejects invite messages over Luma's limit", () => {
  assert.throws(
    () => normalizeInviteMessage("x".repeat(MAX_INVITE_MESSAGE_LENGTH + 1)),
    /200 characters or fewer/,
  );
});
