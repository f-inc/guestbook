import test from "node:test";
import assert from "node:assert/strict";
import { emailDecision, lumaIssueResult } from "./email-policy";
import { eligibleInvitationRecipients } from "./invite-tracking-store";

test("verification never overrides a Luma restriction or calendar opt-out", () => {
  const row = { state: "deliverable", checkedAt: new Date(), lumaBlockedReason: "bounced" };
  assert.equal(emailDecision(row).status, "blocked");
  assert.equal(emailDecision({ ...row, lumaBlockedReason: null }, true).status, "blocked");
});
test("only fresh undeliverable verification blocks; uncertainty stays sendable", () => {
  assert.equal(emailDecision({ state: "undeliverable", checkedAt: new Date() }).status, "blocked");
  assert.equal(emailDecision({ state: "undeliverable", checkedAt: new Date(0) }).status, "unchecked");
  assert.equal(emailDecision({ state: "risky", checkedAt: new Date(), flags: { acceptAll: true } }).status, "unconfirmed");
  assert.equal(emailDecision({ state: "deliverable", checkedAt: new Date() }).status, "eligible");
  assert.equal(emailDecision(null).status, "unchecked");
});
test("unrecognized Luma responses must never clear an exclusion", () => {
  for (const payload of [null, {}, { status: "ok" }, "false"]) assert.equal(lumaIssueResult(payload), null);
  assert.equal(lumaIssueResult({ has_issue: false }), false);
  assert.equal(lumaIssueResult({ has_issue: false, bounced_at: "2026-01-01" }), true);
});
test("shared sending gate excludes fresh undeliverable addresses and keeps accept-all", async () => {
  const db: any = { emailAddress: { findMany: async () => [
    { emailLower: "bad@example.com", state: "undeliverable", checkedAt: new Date() },
    { emailLower: "maybe@example.com", state: "risky", checkedAt: new Date(), flags: { acceptAll: true } },
  ] } };
  const result = await eligibleInvitationRecipients([{ email: "BAD@example.com" }, { email: "maybe@example.com" }, { email: "unchecked@example.com" }], db);
  assert.deepEqual(result.excluded.map(r => r.email), ["BAD@example.com"]);
  assert.equal(result.eligible.length, 2);
});
