import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SELECTED_EVENT_IDS } from "../../event-selection";
import { normalizeMultiEventIds } from "./multi-event-stats";

test("normalizes, deduplicates, and bounds multi-event statistic ids", () => {
  assert.deepEqual(normalizeMultiEventIds([" evt-1 ", "evt-1", "evt-2", "bad id", null]), ["evt-1", "evt-2"]);
  assert.equal(
    normalizeMultiEventIds(Array.from({ length: MAX_SELECTED_EVENT_IDS + 10 }, (_, index) => `evt-${index}`)).length,
    MAX_SELECTED_EVENT_IDS,
  );
});
