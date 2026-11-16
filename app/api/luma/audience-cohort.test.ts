import assert from "node:assert/strict";
import test from "node:test";
import { audienceAnswerCount, audienceCohortLabel, isNoShowAudienceGuest } from "../../audience-cohort";

test("answer counts use accepted no-shows rather than all unchecked registrations", () => {
  const option = { count: 12, checkedInCount: 5, noShowCount: 2 };
  assert.equal(audienceAnswerCount(option, "not_attended"), 2);
  assert.equal(audienceAnswerCount(option, "attended"), 5);
  assert.equal(audienceAnswerCount(option, "registered"), 12);
  assert.equal(audienceAnswerCount({}, "not_attended"), 0);
  assert.equal(audienceAnswerCount({ count: 2, checkedInCount: 2 }, "not_attended"), 0);
  assert.equal(audienceCohortLabel("not_attended"), "Didn’t attend");
});


test("no-shows require acceptance and no check-in evidence", () => {
  for (const status of ["going", "no_show"]) {
    assert.equal(isNoShowAudienceGuest({ status }), true);
    assert.equal(isNoShowAudienceGuest({ status, checkedInAt: "timestamp" }), false);
  }
  for (const status of ["registered", "waitlisted", "declined", "invited", "checked_in", ""]) {
    assert.equal(isNoShowAudienceGuest({ status }), false);
  }
});
