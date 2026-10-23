// This contract is shared by the projection and the read-only review screen.
// These are source facts, never replacements for canonical CIO profile fields.
export const CIO_ANSWER_MAPPINGS = [
  { key: "company", labels: ["Company", "Company name"], kind: "text" },
  { key: "job_title", labels: ["Job title"], kind: "text" },
  { key: "role", labels: ["What is your role?", "Which of the following best describes you?"], kind: "text" },
  { key: "city", labels: ["City", "What city are you based in?"], kind: "text" },
  { key: "country", labels: ["Country"], kind: "text" },
  { key: "project", labels: ["What are you currently working on?", "What are you working on?"], kind: "text" },
  { key: "project_url", labels: ["Project URL", "Company website"], kind: "url" },
  { key: "linkedin_url", labels: ["LinkedIn", "LinkedIn URL", "LinkedIn profile", "(Optional) What is your LinkedIn profile?"], kind: "linkedin" },
] as const;

export const CIO_TAG_MAPPINGS = [
  { label: "Blacklist", key: "blacklist", exclusion: true },
  { label: "No Invite", key: "no_invite", exclusion: true },
  ...["Team", "Partner", "Referred", "Community", "Guest Pass", "All Portfolio", "SF Portfolio",
    "Artifact I", "Blueprint I", "Blueprint II", "Canopy I", "Off Season I", "Off Season II"]
    .map(label => ({ label, key: label.toLowerCase().replaceAll(" ", "_"), exclusion: false })),
];
export const normalizeCioTag = (name: string) => name.normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const normalizeCioQuestion = (name: string) => name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?:]+$/, "");

export function projectCioTags(people: Record<string, any>[], definitions: { name: string; semanticKey: string | null }[] = []) {
  // The index holds the current combined tag membership; do not infer membership
  // from the append-only mutation log or copy automatic attendance classifiers.
  const names = new Set(people.flatMap(p => Array.isArray(p.tags) ? p.tags.filter((t: unknown) => typeof t === "string").map(normalizeCioTag) : []));
  const matches = CIO_TAG_MAPPINGS.filter(m => names.has(normalizeCioTag(m.label))).map(m => m.key);
  for (const definition of definitions) {
    if (names.has(normalizeCioTag(definition.name)) && ["cio_blacklist", "cio_no_invite"].includes(definition.semanticKey || "")) {
      matches.push(definition.semanticKey!.slice(4));
    }
  }
  const tags = [...new Set(matches)].sort();
  return { tags, blacklisted: tags.includes("blacklist"), noInvite: tags.includes("no_invite") };
}

export type CioAnswerFact = { value: string; answered_at: number; time_basis: "answer" | "registration"; event_id: string; question_id: string };
export type CioAnswerState = Record<string, CioAnswerFact>;
const sourceTime = (value: unknown, now: number) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 && time <= now + 300_000 ? Math.floor(time / 1000) : null;
};
const textValue = (answer: any): string | null => {
  const value = answer?.value ?? answer?.answer ?? answer?.response;
  // Structured company objects and multi-choice arrays need their own reviewed
  // mapping. Do not flatten them into an invented title or company name.
  return typeof value === "string" && value.trim() && value.length <= 2000 ? value.trim() : null;
};
function validValue(value: string, kind: string) {
  if (kind === "text") return true;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      (kind !== "linkedin" || /(^|\.)linkedin\.com$/i.test(url.hostname));
  } catch { return false; }
}

function normalizeAnswerValue(value: string, kind: string): string | null {
  // Guestbook can display a LinkedIn answer as an unambiguous /in/<slug>
  // path. Only expand that narrow form for a mapped LinkedIn question; do not
  // guess hosts for other relative URLs or accept redirects/credentials.
  if (kind === "linkedin" && /^\/in\/[a-z0-9][a-z0-9_-]*\/?$/i.test(value)) {
    return `https://www.linkedin.com${value}`;
  }
  return validValue(value, kind) ? value : null;
}

export function projectCioAnswers(guests: Record<string, any>[], previous: CioAnswerState = {}, now = new Date()) {
  const state: CioAnswerState = {};
  const review = new Set<string>();
  const ignored = new Set<string>();
  for (const mapping of CIO_ANSWER_MAPPINGS) {
    const candidates: CioAnswerFact[] = [];
    const prior = previous[mapping.key];
    const validPrior = prior && typeof prior.value === "string" && Number.isFinite(prior.answered_at) && prior.answered_at > 0 &&
        prior.answered_at <= Math.floor(now.getTime() / 1000) + 300 && validValue(prior.value, mapping.kind);
    if (validPrior) candidates.push(prior);
    for (const guest of guests) {
      // Raw Luma data preserves source clocks lost by legacy normalization.
      const answers = Array.isArray(guest.raw?.registration_answers) ? guest.raw.registration_answers : guest.registrationAnswers;
      if (!Array.isArray(answers)) continue;
      for (const answer of answers) {
        const label = answer?.label ?? answer?.question_label ?? answer?.question_text ?? answer?.question?.label ?? answer?.question?.title;
        if (typeof label !== "string" || !mapping.labels.some(l => normalizeCioQuestion(l) === normalizeCioQuestion(label))) continue;
        const rawValue = textValue(answer);
        if (!rawValue) {
          if (answer?.value != null && answer.value !== "") review.add(`${mapping.key}:unsupported_or_blank`);
          continue;
        }
        const value = normalizeAnswerValue(rawValue, mapping.kind);
        if (!value) { review.add(`${mapping.key}:invalid_value`); continue; }
        // Never use a guest updated_at (approval/check-in can change it), event
        // date, cache synced_at, or import time as an answer edit timestamp.
        const explicit = answer.updated_at ?? answer.answered_at ?? answer.submitted_at;
        const answeredAt = sourceTime(explicit ?? guest.raw?.registered_at, now.getTime());
        if (!answeredAt) { review.add(`${mapping.key}:unknown_source_time`); continue; }
        candidates.push({ value, answered_at: answeredAt, time_basis: explicit != null ? "answer" : "registration",
          event_id: String(guest.eventId), question_id: String(answer.question_id ?? answer.question?.id ?? answer.id ?? label) });
      }
    }
    candidates.sort((a,b) => b.answered_at - a.answered_at || a.event_id.localeCompare(b.event_id) || a.question_id.localeCompare(b.question_id));
    const latest = candidates[0];
    if (!latest) continue;
    const tied = candidates.filter(c => c.answered_at === latest.answered_at);
    if (new Set(tied.map(c => c.value)).size > 1) {
      review.add(`${mapping.key}:equal_time_conflict`);
      // Retain the last successfully delivered fact; never pick an arbitrary
      // winner or overwrite it with null when evidence is ambiguous.
      if (validPrior) state[mapping.key] = prior;
    } else state[mapping.key] = latest;
    if (candidates.some(c => c.answered_at < latest.answered_at && c.value !== latest.value)) ignored.add(mapping.key);
  }
  return { state, review: [...review].sort(), olderIgnored: [...ignored].sort() };
}
