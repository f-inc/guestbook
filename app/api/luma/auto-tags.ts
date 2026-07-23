export const AUTOMATIC_TAG_DEFINITIONS = [
  { ruleKey: "new_guest", name: "✨ New", color: "#2563eb" },
  { ruleKey: "superpower_user", name: "🚀 Superpower User", color: "#7c3aed" },
  { ruleKey: "power_user", name: "⚡ Power User", color: "#dc2626" },
  { ruleKey: "festival_dweller", name: "🎪 Festival Dweller", color: "#d97706" },
  { ruleKey: "consistent", name: "🤞 Consistent", color: "#65a30d" },
  { ruleKey: "reliable", name: "🙏 Reliable", color: "#0f766e" },
  { ruleKey: "flaker", name: "👻 Flaker", color: "#ca8a04" },
  { ruleKey: "superflaker", name: "💀 Superflaker", color: "#be123c" },
] as const;

export const NEW_GUEST_MAX_REGISTRATIONS = 3;
export const AUTOMATIC_TAG_RULESET_VERSION = "5";

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

export function isNewGuestTagEligible({ registrationCount = 0, checkInCount = 0 } = {}) {
  return registrationCount >= 1
    && registrationCount <= NEW_GUEST_MAX_REGISTRATIONS
    && checkInCount === 0;
}

export function attendanceRatioTagRule({ registrationCount = 0, checkInCount = 0 } = {}) {
  if (registrationCount < 1 || checkInCount < 0) return null;
  const boundedCheckInCount = Math.min(checkInCount, registrationCount);
  if (registrationCount >= 2 && boundedCheckInCount * 100 >= registrationCount * 90) return "reliable";
  if (boundedCheckInCount >= 2 && boundedCheckInCount * 100 >= registrationCount * 75) return "consistent";
  return null;
}
