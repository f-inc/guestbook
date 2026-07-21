export const AUTOMATIC_TAG_DEFINITIONS = [
  { ruleKey: "superpower_user", name: "🚀 Superpower User", color: "#7c3aed" },
  { ruleKey: "power_user", name: "⚡ Power User", color: "#dc2626" },
  { ruleKey: "festival_dweller", name: "🎪 Festival Dweller", color: "#d97706" },
  { ruleKey: "flaker", name: "👻 Flaker", color: "#ca8a04" },
  { ruleKey: "superflaker", name: "💀 Superflaker", color: "#be123c" },
] as const;

export const AUTOMATIC_TAG_RULE_KEYS = AUTOMATIC_TAG_DEFINITIONS.map((definition) => definition.ruleKey);

const MAX_INCREMENTAL_PEOPLE = 50_000;

export function normalizeAutomaticTagPersonIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => /^[a-z0-9@._-]{1,200}$/i.test(value)),
  )].slice(0, MAX_INCREMENTAL_PEOPLE);
}

export function automaticTagRunMode({
  forceFull = false,
  hasPreviousRun = false,
  previousFingerprint = "",
  currentFingerprint = "",
  personIds = [],
} = {}) {
  if (forceFull || !hasPreviousRun || previousFingerprint !== currentFingerprint) return "full";
  return personIds.length ? "incremental" : "noop";
}
