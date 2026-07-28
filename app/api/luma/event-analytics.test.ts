import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistrationQuestionAnalytics, eventWideAnalyticsCounts, invitationOutcomeCounts } from "../../event-analytics";

test("uses event-wide stats instead of the currently loaded guest page", () => {
  const counts = eventWideAnalyticsCounts(
    {
      total: 66,
      invited: 0,
      registered: 51,
      accepted: 43,
      checkedIn: 21,
      firstRegisters: 20,
      newRegistrations: 29,
      newReferrals: 6,
      newFaces: 9,
      referredRegistrations: 14,
      referredAccepted: 11,
      referredCheckedIn: 7,
      referredFirstRegisters: 4,
      referredReturning: 7,
    },
    {
      registrations: 20,
      accepted: 12,
      checkedIn: 8,
      firstRegisters: 12,
      newRegistrations: 16,
      newReferrals: 1,
      newFaces: 4,
      returningAccepted: 0,
      referredRegistrations: 2,
      referredAccepted: 1,
      referredCheckedIn: 1,
      referredFirstRegisters: 1,
      referredReturning: 0,
    },
  );

  assert.deepEqual(counts, {
    registrations: 51,
    accepted: 43,
    checkedIn: 21,
    firstRegisters: 20,
    newRegistrations: 29,
    newReferrals: 6,
    newFaces: 9,
    referredRegistrations: 14,
    referredAccepted: 11,
    referredCheckedIn: 7,
    referredFirstRegisters: 4,
    referredReturning: 7,
    returningAccepted: 23,
  });
});

test("falls back to loaded rows when event-wide stats are unavailable", () => {
  const fallback = {
    registrations: 4,
    accepted: 3,
    checkedIn: 2,
    firstRegisters: 1,
    newRegistrations: 2,
    newReferrals: 1,
    newFaces: 1,
    returningAccepted: 2,
    referredRegistrations: 2,
    referredAccepted: 2,
    referredCheckedIn: 1,
    referredFirstRegisters: 0,
    referredReturning: 2,
  };
  assert.equal(eventWideAnalyticsCounts(null, fallback), fallback);
});

test("keeps referral cohorts inside their parent funnel stages", () => {
  const counts = eventWideAnalyticsCounts(
    {
      total: 10,
      registered: 8,
      accepted: 6,
      checkedIn: 3,
      firstRegisters: 2,
      newRegistrations: 5,
      newReferrals: 12,
      newFaces: 1,
      referredRegistrations: 20,
      referredAccepted: 10,
      referredCheckedIn: 8,
      referredFirstRegisters: 4,
      referredReturning: 9,
    },
    {
      registrations: 0,
      accepted: 0,
      checkedIn: 0,
      firstRegisters: 0,
      newRegistrations: 0,
      newReferrals: 0,
      newFaces: 0,
      returningAccepted: 0,
      referredRegistrations: 0,
      referredAccepted: 0,
      referredCheckedIn: 0,
      referredFirstRegisters: 0,
      referredReturning: 0,
    },
  );

  assert.equal(counts.referredRegistrations, 8);
  assert.equal(counts.newReferrals, 3);
  assert.equal(counts.referredAccepted, 6);
  assert.equal(counts.referredCheckedIn, 3);
  assert.equal(counts.referredFirstRegisters, 2);
  assert.equal(counts.referredReturning, 4);
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

test("retains all free-text responses for incremental rendering", () => {
  const questions = buildRegistrationQuestionAnalytics(Array.from({ length: 12 }, (_, index) => ({
    personId: `person-${index}`,
    registrationAnswers: [{ id: "intro", label: "What are you building?", value: `Distinct response ${index}` }],
  })));

  assert.equal(questions[0].kind, "text");
  assert.equal(questions[0].responseCount, 12);
  assert.equal(questions[0].responses.length, 12);
});

test("orders founder-stage answers by progression instead of popularity", () => {
  const values = [
    "Launched",
    "Launched",
    "Raised Pre-seed",
    "Shipped Prototype",
    "Tinkering",
    "None of the above",
    "Quitting Job Soon",
    "I Have a Job",
    "Off Zero",
    "Raised Seed",
  ];
  const questions = buildRegistrationQuestionAnalytics(values.map((value, index) => ({
    personId: `person-${index}`,
    registrationAnswers: [{ id: "stage", label: "Where are you at?", value }],
  })));

  assert.deepEqual(questions[0].options.map(({ label }) => label), [
    "I Have a Job",
    "Quitting Job Soon",
    "Tinkering",
    "Shipped Prototype",
    "Launched",
    "Off Zero",
    "Raised Pre-seed",
    "Raised Seed",
    "None of the above",
  ]);
});

test("matches Luma's event-wide outcome buckets while keeping the invitation total explicit", () => {
  assert.deepEqual(invitationOutcomeCounts(null, [
    { status: "going", invitedAt: "2026-07-01", isReferred: true },
    { status: "checked_in", invitedAt: "2026-07-01", checkedInAt: "2026-07-02", isReferred: true },
    { status: "no_show", invitedAt: "2026-07-01" },
    { status: "invited", isReferred: true },
    { status: "declined", invitedAt: "2026-07-01" },
    { status: "checked_in", checkedInAt: "2026-07-02" },
    { status: "going" },
  ]), {
    total: 5,
    going: 2,
    checkedIn: 2,
    noShow: 1,
    noResponse: 1,
    declined: 1,
    referralTotal: 3,
    referralGoing: 1,
    referralCheckedIn: 1,
    referralNoShow: 0,
    referralNoResponse: 1,
    referralDeclined: 0,
  });
});
