import test from "node:test";
import assert from "node:assert/strict";
import { issueEvidence, timelineIssues } from "./email-issues";
test("repeated observations of one failed message count once across events", () => {
  const m = {
    id: "email-one",
    status: "bounced",
    sentAt: "2026-09-01T00:00:00Z",
    bouncedAt: "2026-09-01T00:01:00Z",
  };
  assert.deepEqual(
    issueEvidence([{ messages: [m], issueMessages: [m] }, { messages: [m] }]),
    { bouncedCount: 1, reportedCount: 0, lastFailureAt: m.bouncedAt },
  );
});
test("separate failed messages count separately with latest failure time", () => {
  const result = issueEvidence([
    {
      messages: [
        { id: "a", status: "bounced", bouncedAt: "2026-09-01T00:00:00Z" },
        { id: "b", status: "bounced", bouncedAt: "2026-09-02T00:00:00Z" },
      ],
      issueMessages: [
        { id: "c", status: "reported", reportedAt: "2026-09-03T00:00:00Z" },
      ],
    },
  ]);
  assert.equal(result.bouncedCount, 2);
  assert.equal(result.reportedCount, 1);
  assert.equal(result.lastFailureAt, "2026-09-03T00:00:00Z");
});
test("generic issue flags do not fabricate a failed-message count or timestamp", () => {
  assert.deepEqual(
    issueEvidence([{ issueReason: "bounced", checkedAt: new Date() }]),
    { bouncedCount: 0, reportedCount: 0, lastFailureAt: null },
  );
});
test("non-invitation failed emails retain their own ID and subject", () => {
  const messages = timelineIssues([
    {
      type: "email-sent",
      id: "timeline",
      email: {
        api_id: "email-one",
        email_type: "reminder",
        subject: "Event reminder",
        bounced_at: "2026-09-01T00:00:00Z",
      },
    },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "email-one");
  assert.equal(messages[0].emailType, "reminder");
  assert.equal(messages[0].subject, "Event reminder");
});
