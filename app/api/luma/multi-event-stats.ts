import { MAX_SELECTED_EVENT_IDS } from "../../event-selection";

export function normalizeMultiEventIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => /^[a-z0-9@._-]{1,160}$/i.test(value)))]
    .slice(0, MAX_SELECTED_EVENT_IDS);
}
