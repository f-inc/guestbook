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
    guestLatestTagId: "auto-reliable",
    guestLatestTagLabel: "🙏 Reliable",
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
  assert.equal(query.latestTagId, "auto-reliable");
  assert.equal(query.latestTagLabel, "🙏 Reliable");
});

test("normalizes multi-status rules for all-matching updates", () => {
  const query = parseAllMatchingGuestQuery({
    guestStatus: "accepted",
    guestStatuses: ["accepted", "checked_in"],
    guestStatusMode: "all",
    guestExcludedStatuses: ["no_show"],
  });
  assert.deepEqual(query.filters, ["accepted", "checked_in"]);
  assert.equal(query.filterMode, "all");
  assert.deepEqual(query.excludedFilters, ["no_show"]);
});

test("fails closed when an all-matching query is missing or malformed", () => {
  assert.throws(() => parseAllMatchingGuestQuery({}), /valid guest status/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "everything" }), /valid guest status/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestTags: "Referred" }), /array/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestTagMode: "none" }), /any or all/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "all", guestExcludedTags: "Flaker" }), /array/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatuses: "accepted" }), /array/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "accepted", guestStatuses: ["accepted"], guestStatusMode: "none" }), /any or all/i);
  assert.throws(() => parseAllMatchingGuestQuery({ guestStatus: "accepted", guestStatuses: ["accepted"], guestExcludedStatuses: ["everything"] }), /valid/i);
});

test("normalizes and validates all-matching event ids", () => {
  assert.deepEqual(parseAllMatchingEventIds([" evt-1 ", "evt-2"]), ["evt-1", "evt-2"]);
  assert.throws(() => parseAllMatchingEventIds([]), /at least one event/i);
  assert.throws(() => parseAllMatchingEventIds(["evt-1", "bad id"]), /valid/i);
});
