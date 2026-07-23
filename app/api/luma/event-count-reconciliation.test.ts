import assert from "node:assert/strict";
import test from "node:test";
import {
  changedLiveEventCountKeys,
  liveEventCountsFromLumaEvent,
} from "../../event-count-reconciliation";

test("maps Luma guest counts to wrapper metrics", () => {
  assert.deepEqual(liveEventCountsFromLumaEvent({
    id: "evt-1",
    guest_counts: {
      approved: { guests: 249, tickets: 260 },
      waitlist: { guests: 296, tickets: 296 },
      pending_approval: { guests: 83, tickets: 83 },
      invited: { guests: 41, tickets: 0 },
      declined: { guests: 17, tickets: 0 },
      checked_in: { guests: 92, tickets: 95 },
    },
  }), {
    eventId: "evt-1",
    accepted: 249,
    waitlisted: 296,
    pending: 83,
    invited: 41,
    declined: 17,
    checkedIn: 92,
    registered: 628,
  });
});

test("detects changes across the complete event guest-count fingerprint", () => {
  const live = {
    eventId: "evt-1",
    accepted: 249,
    waitlisted: 296,
    pending: 83,
    invited: 41,
    declined: 17,
    checkedIn: 92,
    registered: 628,
  };
  assert.deepEqual(changedLiveEventCountKeys({
    accepted: 249,
    waitlisted: 296,
    pending: 83,
    invitedNoResponse: 41,
    declined: 17,
    checkedIn: 92,
    registered: 628,
  }, live), []);
  assert.deepEqual(changedLiveEventCountKeys({
    accepted: 248,
    waitlisted: 295,
    pending: 82,
    invitedNoResponse: 40,
    declined: 16,
    checkedIn: 91,
    registered: 626,
  }, live), ["accepted", "waitlisted", "pending", "invited", "declined", "checkedIn", "registered"]);
});

test("does not force a refresh before wrapper summary stats are ready", () => {
  assert.deepEqual(changedLiveEventCountKeys({ accepted: 2 }, {
    eventId: "evt-1",
    accepted: 2,
    waitlisted: 1,
    pending: 3,
    invited: 4,
    declined: 5,
    checkedIn: 1,
    registered: 6,
  }), []);
});
