import assert from "node:assert/strict";
import test from "node:test";
import { guestStatusAfterEvent, storedGuestStatus } from "../../guest-display-status";

test("repairs legacy automatic no-show statuses for approved guests", () => {
  assert.equal(storedGuestStatus({
    status: "no_show",
    lumaApprovalStatus: "approved",
    checkedInAt: null,
  }), "going");
});

test("preserves pending and checked-in indexed statuses", () => {
  assert.equal(storedGuestStatus({ status: "registered", lumaApprovalStatus: "pending_approval" }), "registered");
  assert.equal(storedGuestStatus({ status: "going", lumaApprovalStatus: "approved", checkedInAt: "2026-09-04T01:00:00Z" }), "checked_in");
});

test("derives no-show only after the event end time", () => {
  const guest = { status: "going", lumaApprovalStatus: "approved" };
  const event = { endsAt: "2026-09-04T05:00:00.000Z" };

  assert.equal(guestStatusAfterEvent(guest, event, new Date("2026-09-04T04:59:59.000Z")), "going");
  assert.equal(guestStatusAfterEvent(guest, event, new Date("2026-09-04T05:00:00.000Z")), "no_show");
});

test("does not derive no-show without an end time or for cancelled events", () => {
  const guest = { status: "going", lumaApprovalStatus: "approved" };
  const now = new Date("2026-09-04T06:00:00.000Z");

  assert.equal(guestStatusAfterEvent(guest, {}, now), "going");
  assert.equal(guestStatusAfterEvent(guest, { endsAt: "2026-09-04T05:00:00.000Z", cancelled: true }, now), "going");
});
