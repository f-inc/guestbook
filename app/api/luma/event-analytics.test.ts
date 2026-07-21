import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistrationQuestionAnalytics, eventWideAnalyticsCounts } from "../../event-analytics";

test("uses event-wide stats instead of the currently loaded guest page", () => {
  const counts = eventWideAnalyticsCounts(
    { total: 66, invited: 0, accepted: 43, checkedIn: 21, newFaces: 20 },
    { registrations: 20, accepted: 12, checkedIn: 8, newPeople: 20, returning: 0 },
  );

  assert.deepEqual(counts, {
    registrations: 66,
    accepted: 43,
    checkedIn: 21,
    newPeople: 20,
    returning: 46,
  });
});

test("falls back to loaded rows when event-wide stats are unavailable", () => {
  const fallback = { registrations: 4, accepted: 3, checkedIn: 2, newPeople: 1, returning: 3 };
  assert.equal(eventWideAnalyticsCounts(null, fallback), fallback);
});

test("aggregates registration answers independently of guest-list filters", () => {
  const questions = buildRegistrationQuestionAnalytics([
    { personId: "person-1", registrationAnswers: [{ id: "role", label: "Role", value: "Founder" }] },
    { personId: "person-2", registrationAnswers: [{ id: "role", label: "Role", value: "Founder" }] },
    { personId: "person-3", registrationAnswers: [{ id: "role", label: "Role", value: "Investor" }, { label: "LinkedIn", value: "https://example.com" }] },
  ]);

  assert.equal(questions.length, 1);
  assert.equal(questions[0].responseCount, 3);
  assert.deepEqual(questions[0].options.map(({ label, count }) => ({ label, count })), [
    { label: "Founder", count: 2 },
    { label: "Investor", count: 1 },
  ]);
});
