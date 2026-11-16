import assert from "node:assert/strict";
import test from "node:test";
import { findMergeCandidates, mergePhone, mergeSocial, type MergeProfile } from "./merge-matching";
import { aggregateMergedHistory } from "./merge-history";
const person = (personId: string, fields: Partial<MergeProfile> = {}): MergeProfile => ({ personId, name: "Unnamed guest", email: null, phoneNumber: null, socialLinks: [], registrations: [], ...fields });
const signals = (a: MergeProfile, b: MergeProfile) => findMergeCandidates([a, b]).candidates[0]?.evidence.map(e => e.signal) || [];
test("first and last name match reversed names and concatenated email local parts", () => {
  const jane = person("a", { name: "Jane Smith" });
  for (const b of [person("b", { name: "Smith, Jane" }), person("b", { email: "smithjane23@example.test" }), person("b", { email: "jane.smith@example.test" })]) assert.ok(signals(jane, b).includes("name"));
  assert.deepEqual(signals(jane, person("b", { name: "Janet Smith" })), []);
  assert.deepEqual(signals(jane, person("b", { email: "someone@janesmith.test" })), []);
});
test("name parts may appear across email and answer values, never question labels", () => {
  const a = person("a", { name: "Jane Smith" });
  assert.ok(signals(a, person("b", { email: "jane@example.test", registrations: [{ registrationAnswers: [{ label: "Last name", value: "Smith" }] }] })).includes("name"));
  assert.deepEqual(signals(a, person("b", { registrations: [{ registrationAnswers: [{ label: "Jane Smith", value: "No" }] }] })), []);
  assert.ok(signals(person("a", { registrations: [{ registrationAnswers: [{ label: "Full name", value: "Jane Smith" }] }] }), person("b", { email: "smithjane@example.test" })).includes("name"));
});
test("normalizes accents and punctuation without matching substrings in unrelated names", () => {
  assert.ok(signals(person("a", { name: "José García" }), person("b", { name: "JOSE GARCIA" })).includes("name"));
  assert.deepEqual(signals(person("a", { name: "Ann Lee" }), person("b", { name: "Joann Leeman" })), []);
});
test("social match canonicalizes X and Twitter but requires first name on both records", () => {
  const a = person("a", { name: "Jane Smith", socialLinks: [{ url: "https://twitter.com/JaneS?ref=home" }] });
  assert.ok(signals(a, person("b", { name: "Jane Jones", socialLinks: [{ url: "https://x.com/janes/" }] })).includes("social"));
  assert.deepEqual(signals(a, person("b", { name: "Alex Jones", socialLinks: [{ url: "https://x.com/janes" }] })), []);
  assert.deepEqual(signals(person("a", { name: "Jane Smith", socialLinks: [{ url: "https://x.com/acme" }] }), person("b", { name: "Jane Jones", socialLinks: [{ url: "https://x.com/acme" }] })), []);
});
test("only personal social profiles count; tracking parameters and www are ignored", () => {
  assert.equal(mergeSocial("https://www.linkedin.com/in/Jane-Smith/?trk=abc")?.key, "linkedin.com/in/jane-smith");
  for (const value of ["https://linkedin.com/company/jane", "https://linkedin.com.evil.test/in/jane", "https://x.com/jane/status/123", "https://x.com/home", "https://instagram.com/jane"]) assert.equal(mergeSocial(value), null);
});
test("phone uses full numbers including country codes, rejects extensions and short fragments", () => {
  assert.equal(mergePhone("+1 (415) 555-0123"), mergePhone("415-555-0123"));
  assert.equal(mergePhone("0044 20 7946 0123"), mergePhone("+44 20 7946 0123"));
  assert.equal(mergePhone("5550123"), ""); assert.equal(mergePhone("4155550123 ext 9"), "");
  assert.ok(signals(person("a", { registrations: [{ phoneNumber: "+1 415 555 0123" }] }), person("b", { phoneNumber: "4155550123" })).includes("phone"));
});
test("skips already linked profiles, accumulates reasons, and reports candidate truncation", () => {
  const a = person("a", { name: "Jane Smith", phoneNumber: "4155550123" });
  const b = person("b", { name: "Jane Smith", phoneNumber: "4155550123" });
  assert.equal(new Set(signals(a, b)).size, 2);
  assert.deepEqual(findMergeCandidates([{ ...a, canonicalId: "a" }, { ...b, canonicalId: "a" }]).candidates, []);
  const result = findMergeCandidates([a, b, person("c", { name: "Jane Smith" })], 1);
  assert.equal(result.candidates.length, 1); assert.equal(result.truncated, true);
});
test("combined history counts shared events once and preserves check-ins and original records", () => {
  const records = [{ eventId: "event", personId: "a", status: "invited" }, { eventId: "event", personId: "b", status: "checked_in" }, { eventId: "other", personId: "a", status: "going" }];
  const result = aggregateMergedHistory(records);
  assert.equal(result.length, 2); assert.equal(result[0].status, "checked_in"); assert.equal(result[0].linkedRegistrations.length, 2);
  assert.equal(records[0].status, "invited");
});

test("email-only profiles and separate first/last registration fields can establish a name", () => {
  assert.ok(signals(person("a", { email: "jane.smith@example.test" }), person("b", { email: "smith.jane@elsewhere.test" })).includes("name"));
  assert.ok(signals(person("a", { registrations: [{ registrationAnswers: [{ label: "First name", value: "Jane" }, { label: "Last name", value: "Smith" }] }] }), person("b", { email: "janesmith@example.test" })).includes("name"));
});

test("an email alias does not override a known first name for social matching", () => {
  const left = person("a", { name: "Jane Smith", email: "alex.smith@example.test", socialLinks: [{ url: "https://x.com/alexsmith" }] });
  const right = person("b", { name: "Alex Jones", socialLinks: [{ url: "https://x.com/alexsmith" }] });
  assert.ok(!signals(left, right).includes("social"));
});

test("selected rules apply before the candidate cap so name matches cannot hide phone suggestions", () => {
  const profiles = [person("a", { name: "Jane Smith" }), person("b", { name: "Jane Smith" }), person("c", { phoneNumber: "4155550123" }), person("d", { phoneNumber: "4155550123" })];
  const result = findMergeCandidates(profiles, 1, ["phone"]);
  assert.equal(result.candidates[0].left, "c");
  assert.equal(result.candidates[0].right, "d");
  assert.deepEqual(result.candidates[0].evidence.map(e => e.signal), ["phone"]);
});
