import assert from "node:assert/strict";
import test from "node:test";
import { actionsForStatus } from "../../guest-actions";

test("pending registrations require a decision before check-in", () => {
  assert.deepEqual(actionsForStatus("registered"), [
    ["Approve", "going"],
    ["Waitlist", "waitlisted"],
    ["Decline", "declined"],
  ]);
});

test("accepted registrations can be checked in", () => {
  assert.deepEqual(actionsForStatus("going"), [
    ["Check in", "checked_in"],
    ["Waitlist", "waitlisted"],
    ["Decline", "declined"],
  ]);
});
