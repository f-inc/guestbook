const sourcePriority = {
  luma: 0,
  resolver: 1,
  linkedin: 2,
  x: 3,
};

type AvatarSource = keyof typeof sourcePriority | "unknown";

export function avatarSource(value: unknown): AvatarSource {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  if (value.startsWith("/api/luma/avatar")) return "resolver";

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com") || hostname === "licdn.com" || hostname.endsWith(".licdn.com")) return "linkedin";
    if (["x.com", "twitter.com", "twimg.com"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return "x";
  } catch {
    return "unknown";
  }

  // Unclassified direct image URLs originate from Luma's guest payload.
  return "luma";
}

export function orderAvatarCandidates(...groups: unknown[]): string[] {
  const seen = new Set<string>();
  const candidates = groups
    .flat(Infinity)
    .filter((value): value is string => typeof value === "string" && (/^https?:\/\//i.test(value) || value.startsWith("/api/luma/avatar")))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });

  return candidates
    .map((value, index) => ({ value, index, priority: sourcePriority[avatarSource(value)] ?? 4 }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ value }) => value);
}
