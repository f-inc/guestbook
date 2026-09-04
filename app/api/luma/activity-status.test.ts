import assert from "node:assert/strict";
import test from "node:test";
import { activityRecordStatus, eventHasStarted } from "../../activity-status";

const now = new Date("2026-07-12T22:00:00-07:00");

test("keeps a future registration registered", () => {
  const record = {
    status: "no_show",
    registeredAt: "2026-07-11T09:00:00-07:00",
    eventStartsAt: "2026-07-13T09:00:00-07:00",
    eventDate: "2026-07-13",
  };

  assert.equal(eventHasStarted(record, now), false);
  assert.equal(activityRecordStatus(record, now), "registered");
});

test("keeps an approved unchecked registration accepted while the event is running", () => {
  const record = {
    status: "registered",
    lumaApprovalStatus: "approved",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-12T18:00:00-07:00",
    eventEndsAt: "2026-07-12T23:00:00-07:00",
  };

  assert.equal(activityRecordStatus(record, now), "going");
});

test("derives no-show for an approved unchecked registration after the event ends", () => {
  const record = {
    status: "going",
    lumaApprovalStatus: "approved",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-12T18:00:00-07:00",
    eventEndsAt: "2026-07-12T21:00:00-07:00",
  };

  assert.equal(activityRecordStatus(record, now), "no_show");
});

test("keeps an approved unchecked registration accepted before the event starts", () => {
  const record = {
    status: "going",
    lumaApprovalStatus: "approved",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-13T18:00:00-07:00",
  };

  assert.equal(activityRecordStatus(record, now), "going");
});

test("keeps unapproved past registrations registered", () => {
  const record = {
    status: "registered",
    lumaApprovalStatus: "pending_approval",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-12T18:00:00-07:00",
  };

  assert.equal(activityRecordStatus(record, now), "registered");
});

test("keeps declined applications with registration evidence registered in activity", () => {
  const record = {
    status: "declined",
    lumaApprovalStatus: "declined",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-12T18:00:00-07:00",
  };

  assert.equal(activityRecordStatus(record, now), "registered");
});

test("keeps checked-in and invitation-only states", () => {
  assert.equal(activityRecordStatus({ status: "checked_in", eventDate: "2026-07-13" }, now), "checked_in");
  assert.equal(activityRecordStatus({ status: "invited", eventDate: "2026-07-13" }, now), "invited");
});

test("registration evidence outranks an invited status", () => {
  assert.equal(
    activityRecordStatus({
      status: "invited",
      registeredAt: "2026-07-12T20:00:00-07:00",
      invitedAt: "2026-07-11T20:00:00-07:00",
      eventStartsAt: "2026-07-13T09:00:00-07:00",
    }, now),
    "registered",
  );
});

test("treats a date-only event today as not yet started", () => {
  assert.equal(activityRecordStatus({ status: "registered", eventDate: "2026-07-12" }, now), "registered");
});

test("does not blame a guest for an explicitly cancelled event", () => {
  assert.equal(activityRecordStatus({
    status: "no_show",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-12T18:00:00-07:00",
    eventCancelled: true,
  }, now), "cancelled");
});

test("does not call a guest a no-show when the event was deleted", () => {
  assert.equal(activityRecordStatus({
    status: "no_show",
    registeredAt: "2026-07-10T09:00:00-07:00",
    eventStartsAt: "2026-07-12T18:00:00-07:00",
    eventCatalogActive: false,
  }, now), "cancelled");
});

test("preserves a real check-in even if an event is later removed", () => {
  assert.equal(activityRecordStatus({
    status: "checked_in",
    checkedInAt: "2026-07-12T18:05:00-07:00",
    eventCatalogActive: false,
  }, now), "checked_in");
});
