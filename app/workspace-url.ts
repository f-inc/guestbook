export type WorkspaceUrlState = {
  eventId: string;
  eventView: "upcoming" | "past" | "all";
  eventSearch: string;
  tab: "overview" | "invite" | "analytics";
  guestStatus: string;
  guestSearch: string;
  guestTags: string[];
  guestPage: number;
  profileId: string;
};

const EVENT_VIEWS = new Set(["upcoming", "past", "all"]);
const EVENT_TABS = new Set(["overview", "invite", "analytics"]);
const GUEST_STATUSES = new Set([
  "all",
  "to_decide",
  "checked_in",
  "accepted",
  "registered",
  "invited",
  "waitlisted",
  "first_registers",
  "new_faces",
  "declined",
  "no_show",
]);
const WORKSPACE_PARAMS = [
  "event",
  "event_view",
  "event_search",
  "tab",
  "guest_status",
  "guest_search",
  "guest_tag",
  "guest_page",
  "profile",
];

export function parseWorkspaceUrl(search: string): WorkspaceUrlState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const eventView = params.get("event_view") || "upcoming";
  const tab = params.get("tab") || "overview";
  const guestStatus = params.get("guest_status") || "all";
  const requestedPage = Number.parseInt(params.get("guest_page") || "1", 10);

  return {
    eventId: boundedText(params.get("event"), 160),
    eventView: EVENT_VIEWS.has(eventView) ? eventView as WorkspaceUrlState["eventView"] : "upcoming",
    eventSearch: boundedText(params.get("event_search"), 120),
    tab: EVENT_TABS.has(tab) ? tab as WorkspaceUrlState["tab"] : "overview",
    guestStatus: GUEST_STATUSES.has(guestStatus) ? guestStatus : "all",
    guestSearch: boundedText(params.get("guest_search"), 120),
    guestTags: unique(params.getAll("guest_tag").map((tag) => boundedText(tag, 40)).filter(Boolean)).slice(0, 20),
    guestPage: Number.isFinite(requestedPage) ? Math.min(100, Math.max(1, requestedPage)) : 1,
    profileId: boundedText(params.get("profile"), 160),
  };
}

export function buildWorkspaceUrlSearch(currentSearch: string, state: WorkspaceUrlState): string {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  WORKSPACE_PARAMS.forEach((key) => params.delete(key));

  if (state.eventId) params.set("event", state.eventId);
  if (state.eventView !== "upcoming") params.set("event_view", state.eventView);
  if (state.eventSearch) params.set("event_search", state.eventSearch);
  if (state.tab !== "overview") params.set("tab", state.tab);
  if (state.guestStatus !== "all") params.set("guest_status", state.guestStatus);
  if (state.guestSearch) params.set("guest_search", state.guestSearch);
  unique(state.guestTags).forEach((tag) => params.append("guest_tag", tag));
  if (state.guestPage > 1) params.set("guest_page", String(Math.floor(state.guestPage)));
  if (state.profileId) params.set("profile", state.profileId);

  return params.toString();
}

function boundedText(value: string | null, maximum: number) {
  return String(value || "").trim().slice(0, maximum);
}

function unique(values: string[]) {
  return [...new Set(values)];
}
