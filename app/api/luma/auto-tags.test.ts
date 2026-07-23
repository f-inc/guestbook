import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATIC_TAG_DEFINITIONS, attendanceRatioTagRule, automaticTagRunMode, isNewGuestTagEligible, normalizeAutomaticTagPersonIds } from "./auto-tags";

test("gives every automatic tag a distinct emoji label", () => {
  assert.deepEqual(AUTOMATIC_TAG_DEFINITIONS.map(({ name }) => name), [
    "✨ New",
    "🚀 Superpower User",
    "⚡ Power User",
    "🎪 Festival Dweller",
    "🤞 Consistent",
    "🙏 Reliable",
    "👻 Flaker",
    "💀 Superflaker",
  ]);
});

test("classifies lifetime EA/ER attendance ratio tiers", () => {
  assert.equal(attendanceRatioTagRule({ registrationCount: 4, checkInCount: 3 }), "consistent");
  assert.equal(attendanceRatioTagRule({ registrationCount: 9, checkInCount: 8 }), "consistent");
  assert.equal(attendanceRatioTagRule({ registrationCount: 10, checkInCount: 9 }), "reliable");
  assert.equal(attendanceRatioTagRule({ registrationCount: 2, checkInCount: 2 }), "reliable");
  assert.equal(attendanceRatioTagRule({ registrationCount: 1, checkInCount: 1 }), null);
});

test("does not assign attendance ratio tags below 75 percent, below two attendances, or without registrations", () => {
  assert.equal(attendanceRatioTagRule({ registrationCount: 3, checkInCount: 2 }), null);
  assert.equal(attendanceRatioTagRule({ registrationCount: 1, checkInCount: 1 }), null);
  assert.equal(attendanceRatioTagRule({ registrationCount: 0, checkInCount: 0 }), null);
});

test("keeps untested registrants new through their third registration", () => {
  assert.equal(isNewGuestTagEligible({ registrationCount: 1, checkInCount: 0 }), true);
  assert.equal(isNewGuestTagEligible({ registrationCount: 2, checkInCount: 0 }), true);
  assert.equal(isNewGuestTagEligible({ registrationCount: 3, checkInCount: 0 }), true);
});

test("removes the new tag after a check-in or fourth registration", () => {
  assert.equal(isNewGuestTagEligible({ registrationCount: 1, checkInCount: 1 }), false);
  assert.equal(isNewGuestTagEligible({ registrationCount: 3, checkInCount: 2 }), false);
  assert.equal(isNewGuestTagEligible({ registrationCount: 4, checkInCount: 0 }), false);
  assert.equal(isNewGuestTagEligible({ registrationCount: 0, checkInCount: 0 }), false);
});

test("runs a full classification when the public event window changes", () => {
  assert.equal(automaticTagRunMode({
    hasPreviousRun: true,
    previousFingerprint: "evt-old",
    currentFingerprint: "evt-new",
    personIds: ["person-1"],
  }), "full");
});

test("uses an incremental run for changed people when chronology is stable", () => {
  assert.equal(automaticTagRunMode({
    hasPreviousRun: true,
    previousFingerprint: "evt-stable",
    currentFingerprint: "evt-stable",
    personIds: ["person-1"],
  }), "incremental");
});

test("deduplicates and validates incremental person ids", () => {
  assert.deepEqual(normalizeAutomaticTagPersonIds([" person-1 ", "person-1", "bad id", null, "person-2"]), ["person-1", "person-2"]);
});
