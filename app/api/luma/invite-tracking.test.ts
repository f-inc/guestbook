import test from "node:test";
import assert from "node:assert/strict";
import {
  emailStatus,
  invitationMessages,
  latestInviteStatus,
} from "../../invite-tracking";
test("invitation tracking ignores unrelated emails and sorts repeated invitations", () => {
  const entry = (id, type, at) => ({
    id: `timeline-${id}`,
    type: "email-sent",
    timestamp: at,
    email: { api_id: id, email_type: type, sent_at: at },
  });
  const messages = invitationMessages([
    entry("confirm", "to-guest--confirmation", "2026-10-02T00:00:00Z"),
    entry("old", "to-guest--event-invitation", "2026-09-01T00:00:00Z"),
    entry("new", "to-guest--event-invitation", "2026-10-01T00:00:00Z"),
  ]);
  assert.deepEqual(
    messages.map((m) => m.id),
    ["new", "old"],
  );
  assert.equal(
    latestInviteStatus(messages, "2026-10-02T00:00:00Z", "processing"),
    "processing",
  );
});
test("negative evidence takes precedence, nulls never imply success", () => {
  assert.equal(
    emailStatus({ opened_at: "2026-10-01", bounced_at: "2026-10-02" }),
    "bounced",
  );
  assert.equal(
    emailStatus({ clicked_at: "2026-10-01", marked_as_spam_at: "2026-10-02" }),
    "reported",
  );
  assert.equal(emailStatus({ delivered_at: null, opened_at: null }), "unknown");
  assert.equal(emailStatus({ status: "clicked" }), "clicked");
});
test("unrecognized timeline shape cannot erase cached observations", () => {
  assert.throws(() => invitationMessages({ success: true }));
  assert.equal(latestInviteStatus([], null, "opened"), "opened");
});

import { eligibleInvitationRecipients, trackedSend } from "./invite-tracking-store";
test("confirmed exclusions prevent any upstream send", async () => {
  const db: any = {
    lumaCalendarOptOut: {findMany: async () => []},
    emailAddress: {
      findMany: async () => [{ emailLower: "bounce@example.com", lumaBlockedReason: "bounced" }],
    },
  };
  const result = await trackedSend(
    "evt-test",
    [{ email: "BOUNCE@example.com" }],
    "",
    "test",
    {
      publicRequestForEvent: () => {
        throw Error("must not send");
      },
    } as any,
    db,
  );
  assert.equal(result.accepted, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.skippedEmails, ["bounce@example.com"]);
});
test("Luma skipped responses are recorded without being counted as accepted", async () => {
  const states: any[] = [];
  const db: any = {
    lumaCalendarOptOut: {findMany: async () => []},
    emailAddress: { findMany: async () => [] },
    lumaPerson: { findMany: async () => [] },
    lumaEvent: { findUnique: async () => ({ title: "Test" }) },
    lumaInviteTracking: {
      upsert: async () => {},
      update: async (input) => states.push(input),
    },
    lumaInviteAttempt: {
      createMany: async () => {},
      updateMany: async () => {},
    },
  };
  const result = await trackedSend(
    "evt-test",
    [{ email: "skip@example.com" }, { email: "ok@example.com" }],
    "",
    "test",
    {
      publicRequestForEvent: async () => ({
        skipped: [{ email: "skip@example.com" }],
      }),
    } as any,
    db,
  );
  assert.equal(result.accepted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(states[0].data.status, "skipped");
});
