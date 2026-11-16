import assert from "node:assert/strict";
import test from "node:test";
import { audienceAnswerQuestionMode, indexedAudienceCohortPredicateSql, normalizeIndexedAudienceCriteria } from "./db";
import { ANY_REGISTRATION_ANSWER_KEY, isAnyRegistrationAnswer } from "../../audience-answer-rules";

test("represents selecting every response as one bounded wildcard rule", () => {
  assert.equal(isAnyRegistrationAnswer(ANY_REGISTRATION_ANSWER_KEY), true);
  assert.equal(isAnyRegistrationAnswer("founder"), false);
  const normalized = normalizeIndexedAudienceCriteria({
    excludeEventAnswers: [{ eventId: "event-1", question: "Who referred you?", answer: "Any response", answerKey: ANY_REGISTRATION_ANSWER_KEY }],
  });
  assert.deepEqual(normalized.excludeEventAnswers, [
    { eventId: "event-1", question: "Who referred you?", answer: "Any response", answerKey: ANY_REGISTRATION_ANSWER_KEY },
  ]);
});

test("narrows inclusions across questions but unions exclusions", () => {
  assert.equal(audienceAnswerQuestionMode("include"), "all");
  assert.equal(audienceAnswerQuestionMode("exclude"), "any");
});

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
    includeEventAnswers: [
      { eventId: " event-1 ", cohort: "attended", question: "What best describes you?", answer: "Founder", answerKey: "founder" },
      { eventId: "event-1", cohort: "attended", question: "What best describes you?", answer: "Founder", answerKey: "founder" },
    ],
    excludeEventAnswers: [
      { eventId: " event-1 ", question: "What best describes you?", answer: "Investor", answerKey: "investor" },
      { eventId: "event-1", question: "What best describes you?", answer: "Investor", answerKey: "investor" },
    ],
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
    includeEventAnswers: [
      { eventId: "event-1", cohort: "attended", question: "What best describes you?", answer: "Founder", answerKey: "founder" },
    ],
    excludeEventAnswers: [
      { eventId: "event-1", question: "What best describes you?", answer: "Investor", answerKey: "investor" },
    ],
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
    excludeEventAnswers: [
      { eventId: "event-1", question: "Role", answer: "Investor", answerKey: "" },
      { eventId: "", question: "Role", answer: "Investor", answerKey: "investor" },
    ],
    includeEventAnswers: [
      { eventId: "event-1", cohort: "unknown" as any, question: "Role", answer: "Founder", answerKey: "founder" },
      { eventId: "event-1", cohort: "attended", question: "Role", answer: "Founder", answerKey: "" },
    ],
  }), {
    includeTagIds: [],
    excludeTagIds: [],
    includeSuperTagIds: [],
    excludeSuperTagIds: [],
    includeEventCohorts: [],
    excludeEventCohorts: [],
    includeEventAnswers: [],
    excludeEventAnswers: [],
    excludeExistingEventIds: [],
    includePersonIds: [],
    excludePersonIds: [],
  });
});

test("preserves didn't-attend audiences for additions, subtractions, and answer narrowing", () => {
  const selection = { eventId: "event-1", cohort: "not_attended" as const };
  const rule = { ...selection, question: "Role", answer: "Founder", answerKey: "founder" };
  const normalized = normalizeIndexedAudienceCriteria({
    includeEventCohorts: [selection],
    excludeEventCohorts: [selection],
    includeEventAnswers: [rule],
  });
  assert.deepEqual(normalized.includeEventCohorts, [selection]);
  assert.deepEqual(normalized.excludeEventCohorts, [selection]);
  assert.deepEqual(normalized.includeEventAnswers, [rule]);
});


test("didn't-attend SQL requires acceptance and excludes either kind of check-in evidence", () => {
  const predicate = indexedAudienceCohortPredicateSql("not_attended");
  assert.match(predicate.text, /guest.checked_in_at IS NULL/);
  assert.match(predicate.text, /guest.status <> 'checked_in'/);
  assert.match(predicate.text, /guest.status IN/);
  assert.deepEqual(predicate.values, ["going", "no_show"]);
});

test("multiple didn't-attend events exclude anyone who attended even one selected event", async () => {
  // Explicitly isolated in-memory fixtures: never use the configured application DB.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE luma_event_guests (
      event_id TEXT, person_id TEXT, status TEXT, registered_at TEXT, checked_in_at TEXT
    )`);
    const insert = db.prepare("INSERT INTO luma_event_guests VALUES (?, ?, ?, ?, ?)");
    for (const row of [
      ["a", "missed-both", "no_show", "date", null],
      ["b", "missed-both", "going", "date", null],
      ["a", "attended-b", "no_show", "date", null],
      ["b", "attended-b", "checked_in", "date", null],
      ["a", "attended-a", "going", "date", "timestamp"],
      ["b", "attended-a", "no_show", "date", null],
      ["a", "only-a", "going", "date", null],
      ["b", "only-invited", "invited", null, null],
      ["a", "pending", "registered", "date", null],
      ["a", "waitlisted", "waitlisted", "date", null],
      ["a", "stale-no-show-checkin", "no_show", "date", "timestamp"],
      ["a", "declined-registration", "declined", "date", null],
      ["a", "declined-invite", "declined", null, null],
      ["a", "attended-unselected", "no_show", "date", null],
      ["c", "attended-unselected", "checked_in", "date", "timestamp"],
    ]) insert.run(...row);
    const match = (eventIds: string[]) => {
      const predicate = indexedAudienceCohortPredicateSql("not_attended", eventIds);
      return db.prepare(`SELECT DISTINCT guest.person_id FROM luma_event_guests AS guest
        WHERE guest.event_id IN (${eventIds.map(() => "?").join(",")}) AND ${predicate.sql}
        ORDER BY guest.person_id`).all(...eventIds, ...predicate.values as Array<string | null>)
        .map((row) => row.person_id);
    };
    assert.deepEqual(match(["a", "b"]), ["attended-unselected", "missed-both", "only-a"]);
    // Removing event B makes its attendees eligible again; adding B removes them.
    assert.deepEqual(match(["a"]), ["attended-b", "attended-unselected", "missed-both", "only-a"]);
  } finally {
    db.close();
  }
});
