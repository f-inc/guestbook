import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SELECTED_EVENT_IDS, allVisibleEventSelection, nextEventSelection } from "../../event-selection";

test("selects a forward or reverse range in visible event order", () => {
  const orderedEventIds = ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"];

  assert.deepEqual(nextEventSelection({
    currentIds: ["evt-2"],
    eventId: "evt-5",
    range: true,
    anchorId: "evt-2",
    orderedEventIds,
  }).eventIds, ["evt-2", "evt-3", "evt-4", "evt-5"]);

  assert.deepEqual(nextEventSelection({
    currentIds: ["evt-5"],
    eventId: "evt-2",
    range: true,
    anchorId: "evt-5",
    orderedEventIds,
  }).eventIds, ["evt-5", "evt-2", "evt-3", "evt-4"]);
});

test("preserves additive selection and falls back to one event without a visible range anchor", () => {
  assert.deepEqual(nextEventSelection({
    currentIds: ["evt-1"],
    eventId: "evt-3",
    additive: true,
  }).eventIds, ["evt-1", "evt-3"]);

  assert.deepEqual(nextEventSelection({
    currentIds: ["evt-1"],
    eventId: "evt-3",
    range: true,
    anchorId: "missing",
    orderedEventIds: ["evt-1", "evt-2", "evt-3"],
  }).eventIds, ["evt-3"]);
});

test("selects every visible event within the shared stacked-event limit", () => {
  const selection = allVisibleEventSelection(
    Array.from({ length: MAX_SELECTED_EVENT_IDS + 10 }, (_, index) => `evt-${index}`),
  );

  assert.equal(selection.eventIds.length, MAX_SELECTED_EVENT_IDS);
  assert.equal(selection.primaryEventId, "evt-0");

  assert.equal(
    allVisibleEventSelection(["evt-1", "evt-2", "evt-3"], "evt-2").primaryEventId,
    "evt-2",
  );
});
