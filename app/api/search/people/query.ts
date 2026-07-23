export function parsePeopleSearchQuery(searchParams: URLSearchParams) {
  const query = (searchParams.get("q") || "").trim().slice(0, 120);
  const requestedLimit = Number.parseInt(searchParams.get("limit") || "8", 10);
  const scope = searchParams.get("scope") === "name" ? "name" : "all";
  const maxLimit = scope === "name" ? 50 : 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(maxLimit, requestedLimit)) : 8;
  return { query, limit, scope };
}
