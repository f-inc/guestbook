import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATIC_TAG_DEFINITIONS, automaticTagRunMode, normalizeAutomaticTagPersonIds } from "./auto-tags";

test("gives every automatic tag a distinct emoji label", () => {
  assert.deepEqual(AUTOMATIC_TAG_DEFINITIONS.map(({ name }) => name), [
    "🚀 Superpower User",
    "⚡ Power User",
    "🎪 Festival Dweller",
    "👻 Flaker",
    "💀 Superflaker",
  ]);
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
