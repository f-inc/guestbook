const MAX_MULTI_EVENT_IDS = 50;

export function normalizeMultiEventIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => /^[a-z0-9@._-]{1,160}$/i.test(value)))]
    .slice(0, MAX_MULTI_EVENT_IDS);
}
