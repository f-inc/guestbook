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
