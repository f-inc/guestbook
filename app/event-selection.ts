export const MAX_SELECTED_EVENT_IDS = 500;

type EventSelectionOptions = {
  currentIds?: string[];
  eventId: string;
  additive?: boolean;
  range?: boolean;
  anchorId?: string;
  orderedEventIds?: string[];
};

export function nextEventSelection({
  currentIds = [],
  eventId,
  additive = false,
  range = false,
  anchorId = "",
  orderedEventIds = [],
}: EventSelectionOptions) {
  const current = normalizedEventIds(currentIds);
  const ordered = normalizedEventIds(orderedEventIds);
  let eventIds = [eventId];

  if (range && anchorId) {
    const anchorIndex = ordered.indexOf(anchorId);
    const eventIndex = ordered.indexOf(eventId);
    if (anchorIndex >= 0 && eventIndex >= 0) {
      const start = Math.min(anchorIndex, eventIndex);
      const end = Math.max(anchorIndex, eventIndex);
      eventIds = normalizedEventIds([...current, ...ordered.slice(start, end + 1)]);
    }
  } else if (additive) {
    eventIds = current.includes(eventId)
      ? current.length > 1 ? current.filter((id) => id !== eventId) : current
      : normalizedEventIds([...current, eventId]);
  }

  const primaryEventId = eventIds.includes(eventId) ? eventId : eventIds.at(-1) || eventId;
  return { eventIds, primaryEventId, anchorId: eventId };
}

export function allVisibleEventSelection(eventIds: string[], preferredEventId = "") {
  const selectedEventIds = normalizedEventIds(eventIds);
  const primaryEventId = selectedEventIds.includes(preferredEventId)
    ? preferredEventId
    : selectedEventIds[0] || "";
  return {
    eventIds: selectedEventIds,
    primaryEventId,
    anchorId: primaryEventId,
  };
}

export function reconcileEventSelection(
  availableEventIds: string[],
  selectedEventId: string,
  selectedEventIds: string[],
  fallbackEventId = "",
) {
  const available = normalizedEventIds(availableEventIds);
  const selected = normalizedEventIds(selectedEventIds);
  const requestedPrimary = typeof selectedEventId === "string" ? selectedEventId.trim() : "";

  // URL state is restored before the async event catalog is available. Keep
  // that unresolved selection so unrelated early responses (such as tags)
  // cannot normalize it away while the catalog is still empty.
  if (!available.length) {
    const primaryEventId = requestedPrimary || selected.at(-1) || "";
    return {
      primaryEventId,
      eventIds: primaryEventId && !selected.includes(primaryEventId)
        ? normalizedEventIds([...selected, primaryEventId])
        : selected,
    };
  }

  const availableSet = new Set(available);
  const primaryEventId = availableSet.has(requestedPrimary)
    ? requestedPrimary
    : availableSet.has(fallbackEventId)
      ? fallbackEventId
      : available[0] || "";
  const eventIds = selected.filter((eventId) => availableSet.has(eventId));
  if (!eventIds.length && primaryEventId) eventIds.push(primaryEventId);
  if (primaryEventId && !eventIds.includes(primaryEventId)) eventIds.push(primaryEventId);
  return { primaryEventId, eventIds };
}

function normalizedEventIds(eventIds: string[]) {
  return [...new Set(
    eventIds
      .filter((eventId): eventId is string => typeof eventId === "string")
      .map((eventId) => eventId.trim())
      .filter(Boolean),
  )].slice(0, MAX_SELECTED_EVENT_IDS);
}
