import assert from "node:assert/strict";
import test from "node:test";
import { normalizePersonTags } from "./person-tags";

test("normalizes and de-duplicates person tags", () => {
  assert.deepEqual(
    normalizePersonTags([" Founder ", "Event  Host", "founder", ""]),
    ["Event Host", "Founder"],
  );
});

test("rejects malformed person tags", () => {
  assert.throws(() => normalizePersonTags("Founder"), /array/);
  assert.throws(() => normalizePersonTags(["x".repeat(41)]), /40 characters/);
});
