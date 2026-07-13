import assert from "node:assert/strict";
import test from "node:test";
import { guestStatusDate, guestStatusTimestamp } from "../../guest-status-date.mjs";

test("uses the timestamp matching the current guest state", () => {
  assert.equal(
    guestStatusDate({ status: "checked_in", checkedInAt: "2026-07-12T18:00:00Z", registeredAt: "2026-07-10T18:00:00Z" }),
    "2026-07-12T18:00:00Z",
  );
  assert.equal(
    guestStatusDate({ status: "invited", invitedAt: "2026-07-09T18:00:00Z", registeredAt: "2026-07-10T18:00:00Z" }),
    "2026-07-09T18:00:00Z",
  );
  assert.equal(
    guestStatusDate({ status: "registered", registeredAt: "2026-07-10T18:00:00Z", updatedAt: "2026-07-11T18:00:00Z" }),
    "2026-07-10T18:00:00Z",
  );
});

test("falls back through state-relevant timestamps", () => {
  assert.equal(
    guestStatusDate({ status: "going", updatedAt: "2026-07-11T18:00:00Z", registeredAt: "2026-07-10T18:00:00Z" }),
    "2026-07-11T18:00:00Z",
  );
  assert.equal(
    guestStatusDate({ status: "checked_in", registeredAt: "2026-07-10T18:00:00Z" }),
    "2026-07-10T18:00:00Z",
  );
});

test("uses the event date only when guest timestamps are unavailable", () => {
  assert.equal(guestStatusDate({ status: "registered" }, { startsAt: "2026-07-13T17:00:00Z" }), "2026-07-13T17:00:00Z");
  assert.equal(guestStatusDate({ status: "registered" }, { date: "2026-07-13" }), "2026-07-13T12:00:00");
  assert.equal(guestStatusTimestamp({ status: "registered" }, {}), 0);
});
