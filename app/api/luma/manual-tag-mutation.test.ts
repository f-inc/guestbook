import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BULK_TAG_IDS,
  MAX_BULK_TAG_MUTATIONS,
  MAX_BULK_TAG_PEOPLE,
  parseBulkManualTagMutation,
  parseManualTagMutation,
} from "../tags/manual-tag-mutation";

test("normalizes an event-attributed manual tag assignment", () => {
  assert.deepEqual(parseManualTagMutation({
    personId: " person-1 ",
    tagId: "tag-1",
    eventId: "evt-1",
    removed: false,
  }), {
    personId: "person-1",
    tagId: "tag-1",
    eventId: "evt-1",
    removed: false,
  });
});

test("accepts removal mutations", () => {
  assert.equal(parseManualTagMutation({ personId: "person-1", tagId: "tag-1", eventId: "evt-1", removed: true }).removed, true);
});

test("requires ids and an explicit boolean mutation", () => {
  assert.throws(() => parseManualTagMutation({ personId: "person-1", tagId: "tag-1", removed: false }), /event id/i);
  assert.throws(() => parseManualTagMutation({ personId: "person-1", tagId: "tag-1", eventId: "evt-1", removed: "false" }), /boolean/i);
});

test("normalizes a bounded bulk tag mutation", () => {
  assert.deepEqual(parseBulkManualTagMutation({
    people: [
      { personId: " person-1 ", eventId: "evt-1" },
      { personId: "person-2", eventId: " evt-2 " },
    ],
    tagIds: [" tag-1 ", "tag-2"],
    removed: true,
  }), {
    people: [
      { personId: "person-1", eventId: "evt-1" },
      { personId: "person-2", eventId: "evt-2" },
    ],
    tagIds: ["tag-1", "tag-2"],
    removed: true,
  });
});

test("accepts an all-matching bulk tag mutation without person ids", () => {
  const mutation = parseBulkManualTagMutation({
    allMatching: true,
    eventIds: ["evt-1", "evt-2"],
    guestStatus: "registered",
    guestSearch: "founder",
    guestTags: ["Referred"],
    tagIds: ["tag-1"],
    removed: false,
  });
  assert.equal("allMatching" in mutation && mutation.allMatching, true);
  if (!("allMatching" in mutation)) return;
  assert.deepEqual(mutation.eventIds, ["evt-1", "evt-2"]);
  assert.deepEqual({ filter: mutation.query.filter, search: mutation.query.search, tags: mutation.query.tags }, {
    filter: "registered",
    search: "founder",
    tags: ["Referred"],
  });
});

test("rejects malformed or unbounded bulk tag mutations", () => {
  assert.throws(() => parseBulkManualTagMutation({ people: [], tagIds: ["tag-1"], removed: false }), /guest/i);
  assert.throws(() => parseBulkManualTagMutation({ people: [{ personId: "person-1", eventId: "evt-1" }], tagIds: [], removed: false }), /tag/i);
  assert.throws(() => parseBulkManualTagMutation({
    people: [{ personId: "person-1", eventId: "evt-1" }, { personId: "person-1", eventId: "evt-2" }],
    tagIds: ["tag-1"],
    removed: false,
  }), /only once/i);
  assert.throws(() => parseBulkManualTagMutation({
    people: [{ personId: "person-1", eventId: "evt-1" }],
    tagIds: Array.from({ length: MAX_BULK_TAG_IDS + 1 }, (_, index) => `tag-${index}`),
    removed: false,
  }), new RegExp(String(MAX_BULK_TAG_IDS)));
  assert.throws(() => parseBulkManualTagMutation({
    people: Array.from({ length: MAX_BULK_TAG_PEOPLE + 1 }, (_, index) => ({ personId: `person-${index}`, eventId: "evt-1" })),
    tagIds: ["tag-1"],
    removed: false,
  }), new RegExp(String(MAX_BULK_TAG_PEOPLE)));
  assert.throws(() => parseBulkManualTagMutation({
    people: Array.from({ length: MAX_BULK_TAG_PEOPLE }, (_, index) => ({ personId: `person-${index}`, eventId: "evt-1" })),
    tagIds: Array.from({ length: MAX_BULK_TAG_MUTATIONS / MAX_BULK_TAG_PEOPLE + 1 }, (_, index) => `tag-${index}`),
    removed: false,
  }), new RegExp(String(MAX_BULK_TAG_MUTATIONS)));
});
