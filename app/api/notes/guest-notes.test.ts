import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GUEST_NOTE_LENGTH, normalizeGuestNote } from "./guest-notes";

test("normalizes guest note line endings and surrounding whitespace", () => {
  assert.equal(normalizeGuestNote("  # Follow up\r\n\r\nCall next week.  "), "# Follow up\n\nCall next week.");
});

test("accepts an empty note and rejects invalid or oversized values", () => {
  assert.equal(normalizeGuestNote("   "), "");
  assert.throws(() => normalizeGuestNote(null), /must be text/);
  assert.throws(() => normalizeGuestNote("x".repeat(MAX_GUEST_NOTE_LENGTH + 1)), /cannot exceed/);
});
