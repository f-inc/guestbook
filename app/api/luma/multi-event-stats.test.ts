import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMultiEventIds } from "./multi-event-stats";

test("normalizes, deduplicates, and bounds multi-event statistic ids", () => {
  assert.deepEqual(normalizeMultiEventIds([" evt-1 ", "evt-1", "evt-2", "bad id", null]), ["evt-1", "evt-2"]);
  assert.equal(normalizeMultiEventIds(Array.from({ length: 60 }, (_, index) => `evt-${index}`)).length, 50);
});
