import test from "node:test";
import assert from "node:assert/strict";
import {
  nextTrackingCheck,
  trackingRetryDelay,
  optOutFromWebhook,
} from "./tracking-policy";
import { eligibleInvitationRecipients } from "./invite-tracking-store";
const now = new Date("2026-10-02T12:00:00Z");
test("tracking gets less frequent with age and stops for terminal failures or historical events", () => {
  assert.equal(
    nextTrackingCheck("processing", now, now)?.getTime(),
    now.getTime() + 30000,
  );
  assert.equal(
    nextTrackingCheck(
      "delivered",
      new Date(now.getTime() - 86400000 * 3),
      now,
    )?.getTime(),
    now.getTime() + 4 * 3600000,
  );
  assert.equal(
    nextTrackingCheck("clicked", now, now)?.getTime(),
    now.getTime() + 4 * 3600000,
  );
  assert.equal(
    nextTrackingCheck("opened", null, now)?.getTime(),
    now.getTime() + 86400000,
  );
  for (const status of ["bounced", "reported", "skipped"])
    assert.equal(nextTrackingCheck(status, now, now), null);
  assert.equal(nextTrackingCheck("delivered", now, now, true), null);
});
test("rate-limit server cooldown is never shortened by exponential backoff", () => {
  assert.equal(trackingRetryDelay(0, 180000), 180000);
  assert.equal(trackingRetryDelay(30), 3600000);
});
test("opt-out scope comes from verified secret mapping, and no cause is invented", () => {
  const p = {
    type: "calendar.person.unsubscribed",
    data: { email: "A@EXAMPLE.COM", calendar_id: "attacker-scope" },
  };
  assert.deepEqual(
    optOutFromWebhook(p, "LUMA_WEBHOOK_SECRET_2", {
      LUMA_WEBHOOK_CALENDAR_ID_2: "cal-real",
    }),
    { calendarId: "cal-real", emailLower: "a@example.com" },
  );
  assert.throws(
    () => optOutFromWebhook(p, "LUMA_WEBHOOK_SECRET", {}),
    /calendar mapping/,
  );
  assert.equal(
    optOutFromWebhook({ type: "guest.updated" }, "LUMA_WEBHOOK_SECRET", {}),
    null,
  );
});
test("calendar opt-out excludes only sends from that calendar", async () => {
  const db: any = {
    emailAddress: { findMany: async () => [] },
    lumaCalendarOptOut: {
      findMany: async () => [
        { calendarId: "cal-a", emailLower: "a@example.com" },
      ],
    },
    lumaEvent: {
      findUnique: async ({ where }) => ({
        raw: {
          calendar: { id: where.eventId === "evt-a" ? "cal-a" : "cal-b" },
        },
      }),
    },
  };
  const guests = [{ email: "a@example.com" }];
  assert.equal(
    (await eligibleInvitationRecipients(guests, db, "evt-a")).eligible.length,
    0,
  );
  assert.equal(
    (await eligibleInvitationRecipients(guests, db, "evt-b")).eligible.length,
    1,
  );
});
test("unresolved calendar scope cannot silently bypass a known opt-out", async () => {
  const db: any = {
    emailAddress: { findMany: async () => [] },
    lumaCalendarOptOut: {
      findMany: async () => [
        { calendarId: "cal-a", emailLower: "a@example.com" },
      ],
    },
    lumaEvent: { findUnique: async () => ({ raw: {} }) },
  };
  await assert.rejects(
    eligibleInvitationRecipients([{ email: "a@example.com" }], db, "evt-a"),
    /calendar information/,
  );
});

import { mergeInvitationMessages } from "../../invite-tracking";
test("partial timeline responses retain observed opens without duplicating a message", () => {
  const merged = mergeInvitationMessages(
    [
      {
        id: "email-1",
        status: "opened",
        sentAt: "2026-10-01",
        openedAt: "2026-10-02",
      },
    ],
    [{ id: "email-1", status: "sent", sentAt: "2026-10-01", openedAt: null }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "opened");
  assert.equal(merged[0].openedAt, "2026-10-02");
});
