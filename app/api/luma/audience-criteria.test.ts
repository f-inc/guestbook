import assert from "node:assert/strict";
import test from "node:test";
import { audienceAnswerQuestionMode, normalizeIndexedAudienceCriteria } from "./db";
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
