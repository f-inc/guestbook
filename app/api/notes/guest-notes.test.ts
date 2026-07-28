import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GUEST_NOTE_LENGTH, normalizeGuestComment, normalizeGuestCommentId, normalizeGuestNote } from "./guest-notes";

test("normalizes guest note line endings and surrounding whitespace", () => {
  assert.equal(normalizeGuestNote("  # Follow up\r\n\r\nCall next week.  "), "# Follow up\n\nCall next week.");
});

test("requires a non-empty comment", () => {
  assert.equal(normalizeGuestComment("  Promising founder.  "), "Promising founder.");
  assert.throws(() => normalizeGuestComment(" \n "), /write a comment/i);
});

test("accepts positive comment ids and rejects malformed ids", () => {
  assert.equal(normalizeGuestCommentId("42"), BigInt(42));
  assert.equal(normalizeGuestCommentId(BigInt(7)), BigInt(7));
  assert.throws(() => normalizeGuestCommentId("0"), /valid comment id/i);
  assert.throws(() => normalizeGuestCommentId("1 OR 1=1"), /valid comment id/i);
});

test("accepts an empty note and rejects invalid or oversized values", () => {
  assert.equal(normalizeGuestNote("   "), "");
  assert.throws(() => normalizeGuestNote(null), /must be text/);
  assert.throws(() => normalizeGuestNote("x".repeat(MAX_GUEST_NOTE_LENGTH + 1)), /cannot exceed/);
});
