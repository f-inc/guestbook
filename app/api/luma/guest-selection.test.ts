import assert from "node:assert/strict";
import test from "node:test";
import { updateGuestSelection } from "../../guest-selection";

const orderedIds = ["person-a", "person-b", "person-c", "person-d", "person-e"];

test("selects the inclusive range between the anchor and shift-clicked guest", () => {
  const selected = updateGuestSelection(new Set(["person-a"]), orderedIds, "person-e", true, "person-b", true);
  assert.deepEqual([...selected], ["person-a", "person-b", "person-c", "person-d", "person-e"]);
});

test("clears an inclusive range when the shift-clicked checkbox is unchecked", () => {
  const selected = updateGuestSelection(new Set(orderedIds), orderedIds, "person-b", false, "person-d", true);
  assert.deepEqual([...selected], ["person-a", "person-e"]);
});

test("falls back to one checkbox when the anchor is not in the visible list", () => {
  const selected = updateGuestSelection(new Set(["person-a"]), orderedIds, "person-c", true, "missing-person", true);
  assert.deepEqual([...selected], ["person-a", "person-c"]);
});
