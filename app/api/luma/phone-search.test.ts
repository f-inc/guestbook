import assert from "node:assert/strict";
import test from "node:test";
import { phoneMatchesSearch, phoneSearchDigits } from "../../phone-search";

test("normalizes formatted phone queries to digits", () => {
  assert.equal(phoneSearchDigits("+1 646-204-7329"), "16462047329");
  assert.equal(phoneSearchDigits("(646) 204.7329"), "6462047329");
  assert.equal(phoneSearchDigits("co-founder"), "");
});

test("matches phone numbers independently of formatting", () => {
  assert.equal(phoneMatchesSearch("+16462047329", "+1 646-204-7329"), true);
  assert.equal(phoneMatchesSearch("+1 (646) 204-7329", "204 7329"), true);
  assert.equal(phoneMatchesSearch("+16462047329", "646-999-0000"), false);
});

test("matches pasted Cmd K phone numbers with spaces and dash variants", () => {
  for (const query of ["+1 919-903-6015", "+1\u00a0919\u2011903\u20116015", "+1\u202f919\u2013903\u20136015", "(919) 903-6015"]) {
    assert.equal(phoneMatchesSearch("+19199036015", query), true);
    assert.equal(phoneMatchesSearch("+1 (919) 903-6015", query), true);
    assert.equal(phoneMatchesSearch("+19199036016", query), false);
  }
  assert.equal(phoneSearchDigits("guest 919-903-6015"), "");
});
