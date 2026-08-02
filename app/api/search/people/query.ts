export function parsePeopleSearchQuery(searchParams: URLSearchParams) {
  const query = (searchParams.get("q") || "").trim().slice(0, 120);
  const requestedLimit = Number.parseInt(searchParams.get("limit") || "8", 10);
  const requestedOffset = Number.parseInt(searchParams.get("offset") || "0", 10);
  const scope = searchParams.get("scope") === "name" ? "name" : "all";
  const maxLimit = scope === "name" ? 50 : 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(maxLimit, requestedLimit)) : 8;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(10_000, requestedOffset)) : 0;
  const includedTags = normalizedList(searchParams.getAll("tag"));
  const excludedTags = normalizedList(searchParams.getAll("exclude_tag"));
  const tagMode: "all" | "any" = searchParams.get("tag_mode") === "all" ? "all" : "any";
  const requestedComments = searchParams.get("comments");
  const comments: "any" | "with" | "without" = requestedComments === "with" || requestedComments === "without"
    ? requestedComments
    : "any";
  return {
    query,
    limit,
    offset,
    scope,
    includedTags,
    excludedTags,
    tagMode,
    comments,
    hasFilters: includedTags.length > 0 || excludedTags.length > 0 || comments !== "any",
  };
}

function normalizedList(values: string[]) {
  return [...new Set(
    values
      .map((value) => value.trim().slice(0, 100))
      .filter(Boolean),
  )].slice(0, 20);
}
