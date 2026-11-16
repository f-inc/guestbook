export type MergeSignal = "name" | "social" | "phone";
export type MergeProfile = {
  personId: string; name: string; email: string | null; phoneNumber: string | null;
  socialLinks: unknown; tags?: unknown; canonicalId?: string;
  registrations: Array<{ email?: string | null; phoneNumber?: string | null; socialLinks?: unknown; registrationAnswers?: unknown }>;
};
export type MergeEvidence = { signal: MergeSignal; value: string };
export type MergeCandidate = { left: string; right: string; evidence: MergeEvidence[] };
const normalized = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s: string): string[] => normalized(s).replace(/['’]/g, "").match(/\p{L}+/gu) || [];
const compact = (s: string) => words(s).join("");

function answerValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(answerValues);
  if (!value || typeof value !== "object") return [];
  // Questions and labels are never identity evidence.
  const object = value as Record<string, unknown>;
  return [object.value, object.answer].flatMap(answerValues);
}
function nameAnswers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(answer => {
    const label = String(answer?.label || answer?.question || "");
    return /\b(full\s*name|your\s*name|name)\b/i.test(label) && !/company|event|business|referr/i.test(label)
      ? answerValues(answer) : [];
  });
}
function identityNames(profile: MergeProfile) {
  const emailNames = [profile.email, ...profile.registrations.map(r => r.email)]
    .filter(Boolean).map(email => email!.split("@")[0]).filter(local => /[._+-]/.test(local));
  const separateNames = profile.registrations.flatMap(r => {
    if (!Array.isArray(r.registrationAnswers)) return [];
    const first = r.registrationAnswers.find(a => /^(first|given)\s*name$/i.test(String(a?.label || a?.question || "").trim()));
    const last = r.registrationAnswers.find(a => /^(last|family|sur)\s*name$/i.test(String(a?.label || a?.question || "").trim()));
    return first && last ? [`${answerValues(first).join(" ")} ${answerValues(last).join(" ")}`] : [];
  });
  return [profile.name, ...emailNames, ...separateNames, ...profile.registrations.flatMap(r => nameAnswers(r.registrationAnswers))]
    .filter(s => s && !s.includes("@") && !/^unnamed guest$/i.test(s))
    .map(s => s.includes(",") ? s.split(",").reverse().join(" ") : s)
    .map(words).filter(parts => parts.length >= 2);
}
export function mergePhone(value: string | null | undefined) {
  const text = (value || "").trim();
  if (!/^[+\d\s().\-]+$/.test(text)) return "";
  let digits = text.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}
export function mergeSocial(value: string): { key: string; handle: string } | null {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (host === "linkedin.com" && parts.length === 2 && parts[0].toLowerCase() === "in") {
      return { key: `linkedin.com/in/${parts[1].toLowerCase()}`, handle: compact(parts[1]) };
    }
    if (["twitter.com", "x.com", "mobile.twitter.com"].includes(host) && parts.length === 1 && /^[a-z0-9_]{1,15}$/i.test(parts[0]) && !/^(home|intent|share|search|explore|settings|i)$/i.test(parts[0])) {
      return { key: `x.com/${parts[0].toLowerCase()}`, handle: compact(parts[0]) };
    }
  } catch { /* Invalid or non-profile URL. */ }
  return null;
}
function socialValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(link => typeof link === "string" ? [link] : typeof link?.url === "string" ? [link.url] : []);
}
function evidenceIndex(profile: MergeProfile) {
  const names = identityNames(profile);
  const answers = profile.registrations.flatMap(r => answerValues(r.registrationAnswers));
  const emails = [profile.email, ...profile.registrations.map(r => r.email)].filter(Boolean) as string[];
  const tokens = new Set([profile.name, ...answers, ...emails.map(e => e.split("@")[0])].flatMap(words));
  const compounds = new Set(emails.map(e => compact(e.split("@")[0])));
  // First/last may be separate registration answers, so retain every value as well.
  answers.forEach(a => compounds.add(compact(a)));
  const profileName = profile.name.includes(",") ? profile.name.split(",").reverse().join(" ") : profile.name;
  const hasProfileName = profileName && !profileName.includes("@") && !/^unnamed guest$/i.test(profileName);
  const firstNames = new Set(hasProfileName ? [words(profileName)[0]] : names.map(n => n[0]));
  firstNames.delete(undefined);
  const socials = [...socialValues(profile.socialLinks), ...profile.registrations.flatMap(r => socialValues(r.socialLinks))]
    .map(mergeSocial).filter(s => s && [...firstNames].some(first => s.handle.includes(first)))
    .map(s => s!.key);
  const phones = [profile.phoneNumber, ...profile.registrations.map(r => r.phoneNumber)].map(mergePhone).filter(Boolean);
  return { names, tokens, compounds, socials: new Set(socials), phones: new Set(phones) };
}

/** Inverted indexes avoid comparing every profile against every other profile. */
export function findMergeCandidates(profiles: MergeProfile[], limit = 1000, enabled: MergeSignal[] = ["name", "social", "phone"]) {
  const indexes = profiles.map(evidenceIndex);
  const tokens = new Map<string, Set<number>>();
  const compounds = new Map<string, Set<number>>();
  const pairs = new Map<string, MergeCandidate>();
  let truncated = false;
  function post(map: Map<string, Set<number>>, key: string, i: number) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(i);
  }
  indexes.forEach((index, i) => {
    index.tokens.forEach(t => post(tokens, t, i));
    index.compounds.forEach(t => post(compounds, t, i));
  });
  function add(a: number, b: number, signal: MergeSignal, value: string) {
    if (a === b || (profiles[a].canonicalId || profiles[a].personId) === (profiles[b].canonicalId || profiles[b].personId)) return;
    const [left, right] = [profiles[a].personId, profiles[b].personId].sort();
    const key = JSON.stringify([left, right]);
    if (!pairs.has(key)) {
      if (pairs.size >= limit) { truncated = true; return; }
      pairs.set(key, { left, right, evidence: [] });
    }
    const evidence = pairs.get(key)!.evidence;
    if (!evidence.some(e => e.signal === signal && e.value === value)) evidence.push({ signal, value });
  }
  if (enabled.includes("name")) indexes.forEach((index, a) => index.names.forEach(name => {
    const first = name[0], last = name.at(-1)!;
    if (first.length < 2 || last.length < 2 || first === last) return;
    const firstSet = tokens.get(first) || new Set<number>();
    const lastSet = tokens.get(last) || new Set<number>();
    const smaller = firstSet.size < lastSet.size ? firstSet : lastSet;
    const larger = smaller === firstSet ? lastSet : firstSet;
    for (const b of smaller) if (larger.has(b)) add(a, b, "name", `${first} ${last}`);
    for (const key of [first + last, last + first]) {
      for (const b of compounds.get(key) || []) add(a, b, "name", `${first} ${last}`);
    }
  }));
  for (const signal of ["social", "phone"] as const) {
    if (!enabled.includes(signal)) continue;
    const buckets = new Map<string, number[]>();
    indexes.forEach((index, a) => {
      for (const value of signal === "social" ? index.socials : index.phones) {
        const previous = buckets.get(value) || [];
        for (const b of previous) add(a, b, signal, value);
        previous.push(a); buckets.set(value, previous);
      }
    });
  }
  return { candidates: [...pairs.values()].sort((a, b) => new Set(b.evidence.map(e => e.signal)).size - new Set(a.evidence.map(e => e.signal)).size), truncated };
}
