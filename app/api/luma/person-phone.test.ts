import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PERSON_PHONE_LENGTH, normalizePersonPhoneNumber } from "./person-phone";

test("normalizes a manually entered phone number", () => {
  assert.equal(normalizePersonPhoneNumber("  +1 (415)  555-0100 ext. 9  "), "+1 (415) 555-0100 ext. 9");
  assert.equal(normalizePersonPhoneNumber(null), "");
});

test("rejects invalid phone values", () => {
  assert.throws(() => normalizePersonPhoneNumber({}), /text/i);
  assert.throws(() => normalizePersonPhoneNumber("extension only"), /digit/i);
  assert.throws(() => normalizePersonPhoneNumber("1".repeat(MAX_PERSON_PHONE_LENGTH + 1)), new RegExp(String(MAX_PERSON_PHONE_LENGTH)));
});
