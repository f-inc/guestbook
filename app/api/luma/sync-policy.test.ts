import assert from "node:assert/strict";
import test from "node:test";
import { requestedEventIds, shouldRefreshEventGuests } from "./sync-policy";

test("deduplicates and bounds explicit autosync event ids", () => {
  assert.deepEqual(requestedEventIds({ eventIds: ["evt-1", "evt-1", null, "evt-2", "evt-3"] }, 2), ["evt-1", "evt-2"]);
});

test("skips fresh guest indexes and refreshes stale ones", () => {
  const now = Date.parse("2026-07-15T20:00:00.000Z");
  const fresh = shouldRefreshEventGuests({
    state: { lastStatus: "success", lastGuestSyncAt: new Date(now - 4 * 60 * 1000), lastGuestCount: 12 },
    forceRefresh: false,
    staleAfterMinutes: 5,
    now,
  });
  const stale = shouldRefreshEventGuests({
    state: { lastStatus: "success", lastGuestSyncAt: new Date(now - 5 * 60 * 1000), lastGuestCount: 12 },
    forceRefresh: false,
    staleAfterMinutes: 5,
    now,
  });

  assert.equal(fresh.refresh, false);
  assert.equal(stale.refresh, true);
  assert.equal(stale.reason, "stale");
});

test("backs off recent sync errors and retries them after the stale window", () => {
  const now = Date.parse("2026-07-16T20:00:00.000Z");
  const recentFailure = shouldRefreshEventGuests({
    state: {
      lastStatus: "not_found",
      lastGuestSyncAt: new Date(now - 60 * 1000),
      lastGuestCount: 0,
    },
    forceRefresh: false,
    staleAfterMinutes: 5,
    now,
  });
  const staleFailure = shouldRefreshEventGuests({
    state: {
      lastStatus: "not_found",
      lastGuestSyncAt: new Date(now - 5 * 60 * 1000),
      lastGuestCount: 0,
    },
    forceRefresh: false,
    staleAfterMinutes: 5,
    now,
  });

  assert.equal(recentFailure.refresh, false);
  assert.equal(recentFailure.reason, "previous_status_not_found_backoff");
  assert.equal(staleFailure.refresh, true);
  assert.equal(staleFailure.reason, "previous_status_not_found");
});
