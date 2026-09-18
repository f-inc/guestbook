export type PeopleSearchUrlState = {
  open: boolean;
  query: string;
  filters: {
    includedTags: string[];
    excludedTags: string[];
    tagMode: "any" | "all";
    comments: "any" | "with" | "without";
  };
};

const PEOPLE_PARAMS = ["people", "people_search", "people_tag", "people_tag_not", "people_tag_mode", "people_comments"];

export function parsePeopleSearchUrl(search: string): PeopleSearchUrlState {
  const params = new URLSearchParams(search);
  const tags = (key: string) => [...new Set(params.getAll(key).map((tag) => tag.trim().slice(0, 200)).filter(Boolean))].slice(0, 20);
  const comments = params.get("people_comments");
  return {
    open: params.get("people") === "1",
    query: (params.get("people_search") || "").slice(0, 120),
    filters: {
      includedTags: tags("people_tag"),
      excludedTags: tags("people_tag_not"),
      tagMode: params.get("people_tag_mode") === "all" ? "all" : "any",
      comments: comments === "with" || comments === "without" ? comments : "any",
    },
  };
}

export function buildPeopleSearchUrlSearch(search: string, state: PeopleSearchUrlState): string {
  const params = new URLSearchParams(search);
  PEOPLE_PARAMS.forEach((key) => params.delete(key));
  if (state.open) {
    params.set("people", "1");
    if (state.query) params.set("people_search", state.query);
    state.filters.includedTags.forEach((tag) => params.append("people_tag", tag));
    state.filters.excludedTags.forEach((tag) => params.append("people_tag_not", tag));
    if (state.filters.tagMode === "all") params.set("people_tag_mode", "all");
    if (state.filters.comments !== "any") params.set("people_comments", state.filters.comments);
  }
  return params.toString();
}
