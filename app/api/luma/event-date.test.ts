import assert from "node:assert/strict";
import test from "node:test";
import { lumaEventDate, lumaEventTimezone } from "./event-date";

test("converts a midnight UTC start into the event's local calendar day", () => {
  assert.equal(
    lumaEventDate({ start_at: "2026-07-14T00:00:00.000Z", timezone: "America/Los_Angeles" }),
    "2026-07-13",
  );
});

test("preserves the UTC day when the event is actually in UTC", () => {
  assert.equal(lumaEventDate({ start_at: "2026-07-14T00:00:00.000Z", timezone: "UTC" }), "2026-07-14");
});

test("uses nested calendar timezone metadata", () => {
  assert.equal(lumaEventTimezone({ calendar: { timezone: "America/New_York" } }), "America/New_York");
});
