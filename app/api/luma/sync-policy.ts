type AnyRecord = Record<string, any>;

export function requestedEventIds(body: AnyRecord, maxEvents: number) {
  return [...new Set(
    (Array.isArray(body.eventIds) ? body.eventIds : [])
      .filter((eventId) => typeof eventId === "string" && eventId.trim()),
  )].slice(0, maxEvents);
}

export function shouldRefreshEventGuests({ state, forceRefresh, staleAfterMinutes, now = Date.now() }) {
  if (forceRefresh) return { refresh: true, reason: "force" };
  if (!state) return { refresh: true, reason: "never_synced" };
  if (!state.lastGuestSyncAt) return { refresh: true, reason: "missing_guest_sync_time" };

  const staleMs = staleAfterMinutes * 60 * 1000;
  const ageMs = now - new Date(state.lastGuestSyncAt).getTime();
  if (!Number.isFinite(ageMs)) return { refresh: true, reason: "invalid_guest_sync_time" };
  if (staleMs > 0 && ageMs < staleMs) {
    const reason = state.error
      ? "previous_error_backoff"
      : state.truncated
        ? "previous_truncated_backoff"
        : state.lastStatus && !["success", "skipped_fresh"].includes(state.lastStatus)
          ? "previous_status_" + state.lastStatus + "_backoff"
          : "fresh";

    return {
      refresh: false,
      reason,
      lastGuestSyncAt: new Date(state.lastGuestSyncAt).toISOString(),
      lastGuestCount: state.lastGuestCount || 0,
    };
  }

  if (state.error) return { refresh: true, reason: "previous_error" };
  if (state.truncated) return { refresh: true, reason: "previous_truncated" };
  if (state.lastStatus && !["success", "skipped_fresh"].includes(state.lastStatus)) return { refresh: true, reason: "previous_status_" + state.lastStatus };
  if (staleMs === 0) return { refresh: true, reason: "stale_disabled" };
  if (ageMs >= staleMs) return { refresh: true, reason: "stale" };

  return {
    refresh: false,
    reason: "fresh",
    lastGuestSyncAt: new Date(state.lastGuestSyncAt).toISOString(),
    lastGuestCount: state.lastGuestCount || 0,
  };
}
