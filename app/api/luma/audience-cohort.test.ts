import assert from "node:assert/strict";
import test from "node:test";
import { audienceAnswerCount, audienceCohortLabel } from "../../audience-cohort";

test("answer counts split registrations into attended and didn't attend", () => {
  const option = { count: 12, checkedInCount: 5 };
  assert.equal(audienceAnswerCount(option, "not_attended"), 7);
  assert.equal(audienceAnswerCount(option, "attended"), 5);
  assert.equal(audienceAnswerCount(option, "registered"), 12);
  assert.equal(audienceAnswerCount({}, "not_attended"), 0);
  assert.equal(audienceAnswerCount({ count: 2, checkedInCount: 2 }, "not_attended"), 0);
  assert.equal(audienceCohortLabel("not_attended"), "Didn’t attend");
});
