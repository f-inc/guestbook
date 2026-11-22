import assert from "node:assert/strict";
import test from "node:test";
import { parseDrilldown } from "../../metrics/read";
test("metric links validate dates, known stages, bounded pagination and filter scope", () => {
  const params = new URLSearchParams({
    stage: "ocRegistered",
    from: "2026-10-01",
    to: "2026-11-22",
    expected: "43",
    location: "Hall",
  });
  params.append("history", "allowed");
  const input = parseDrilldown(params);
  assert.equal(input.stage, "ocRegistered");
  assert.deepEqual(input.historyScope, ["allowed"]);
  assert.equal(input.query.location, "Hall");
  for (const change of [
    { stage: "guestPass" },
    { from: "2026-02-30" },
    { page: "-1" },
    { to: "2029-01-01" },
    { expected: "-1" },
  ]) {
    const bad = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) bad.set(key, value);
    assert.throws(() => parseDrilldown(bad));
  }
  params.append("stage", "firstVisit");
  assert.throws(() => parseDrilldown(params));
});
