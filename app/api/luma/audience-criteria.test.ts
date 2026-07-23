import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIndexedAudienceCriteria } from "./db";

test("normalizes and deduplicates audience include and exclude criteria", () => {
  assert.deepEqual(normalizeIndexedAudienceCriteria({
    includeTagIds: ["tag-1", " tag-1 ", "tag-2", ""],
    excludeTagIds: ["tag-3"],
    includeSuperTagIds: ["super-1", " super-1 "],
    excludeSuperTagIds: ["super-2"],
    includeEventCohorts: [
      { eventId: " event-1 ", cohort: "attended" },
      { eventId: "event-2", cohort: "registered" },
    ],
    excludeEventCohorts: [{ eventId: "event-3", cohort: "invited" }],
    excludeExistingEventIds: ["event-4", " event-4 ", "event-5"],
    includePersonIds: ["person-1", "person-1", "person-2"],
    excludePersonIds: ["person-3"],
  }), {
    includeTagIds: ["tag-1", "tag-2"],
    excludeTagIds: ["tag-3"],
    includeSuperTagIds: ["super-1"],
    excludeSuperTagIds: ["super-2"],
    includeEventCohorts: [
      { eventId: "event-1", cohort: "attended" },
      { eventId: "event-2", cohort: "registered" },
    ],
    excludeEventCohorts: [{ eventId: "event-3", cohort: "invited" }],
    excludeExistingEventIds: ["event-4", "event-5"],
    includePersonIds: ["person-1", "person-2"],
    excludePersonIds: ["person-3"],
  });
});

test("drops malformed audience criteria", () => {
  assert.deepEqual(normalizeIndexedAudienceCriteria({
    includeEventCohorts: [
      { eventId: "", cohort: "attended" },
      { eventId: "event-1", cohort: "unknown" as any },
    ],
  }), {
    includeTagIds: [],
    excludeTagIds: [],
    includeSuperTagIds: [],
    excludeSuperTagIds: [],
    includeEventCohorts: [],
    excludeEventCohorts: [],
    excludeExistingEventIds: [],
    includePersonIds: [],
    excludePersonIds: [],
  });
});
