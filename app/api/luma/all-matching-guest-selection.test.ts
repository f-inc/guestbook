import assert from "node:assert/strict";
import test from "node:test";
import { parseAllMatchingEventIds, parseAllMatchingGuestQuery } from "./all-matching-guest-selection";

test("normalizes an explicit all-matching guest query", () => {
  const query = parseAllMatchingGuestQuery({
    guestStatus: "registered",
    guestSearch: " founder ",
    guestTags: ["Referred", "New"],
    guestTagMode: "all",
    guestExcludedTags: ["Flaker"],
    guestHasNotes: true,
    guestAttendedGreaterThan: 2,
  });
  assert.deepEqual({ filter: query.filter, search: query.search, tags: query.tags }, {
    filter: "registered",
    search: "founder",
    tags: ["New", "Referred"],
  });
  assert.equal(query.hasNotes, true);
  assert.equal(query.attendedGreaterThan, 2);
  assert.equal(query.tagMode, "all");
  assert.deepEqual(query.excludedTags, ["Flaker"]);
});

test("fails closed when an all-matching query is missing or malformed", () => {
  assert.throws(() => parseAllMatchingGuestQuery({}), /valid guest status/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "everything" }), /valid guest status/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestTags: "Referred" }), /array/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestTagMode: "none" }), /any or all/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestExcludedTags: "Flaker" }), /array/i);
});

test("normalizes and validates all-matching event ids", () => {
  assert.deepEqual(parseAllMatchingEventIds([" evt-1 ", "evt-2"]), ["evt-1", "evt-2"]);
  assert.throws(() => parseAllMatchingEventIds([]), /at least one event/i);
  assert.throws(() => parseAllMatchingEventIds(["evt-1", "bad id"]), /valid/i);
});
