import { MAX_SELECTED_EVENT_IDS } from "./event-selection";

export type WorkspaceUrlState = {
  eventId: string;
  eventIds: string[];
  eventView: "upcoming" | "past" | "all";
  eventSearch: string;
  tab: "overview" | "invite" | "analytics";
  guestStatus: string;
  guestStatuses?: string[];
  guestStatusMode?: "any" | "all";
  guestExcludedStatuses?: string[];
  guestSearch: string;
  guestTags: string[];
  guestTagMode?: "any" | "all";
  guestExcludedTags?: string[];
  guestHasNotes?: boolean;
  guestAttendedGreaterThan?: number | null;
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
  "accepted_first_registers",
  "new_faces",
  "referrals",
  "new_referrals",
  "invited_no_response",
  "invited_accepted",
  "invited_going",
  "invited_checked_in",
  "invited_no_show",
  "invited_declined",
  "invited_referrals",
  "invited_referral_no_response",
  "invited_referral_accepted",
  "invited_referral_declined",
  "declined",
  "no_show",
]);
const WORKSPACE_PARAMS = [
  "event",
  "event_view",
  "event_search",
  "tab",
  "guest_status",
  "guest_status_mode",
  "guest_status_not",
  "guest_search",
  "guest_tag",
  "guest_tag_mode",
  "guest_tag_not",
  "guest_has_notes",
  "guest_attended_gt",
  "guest_page",
  "profile",
];

export function parseWorkspaceUrl(search: string): WorkspaceUrlState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const eventView = params.get("event_view") || "upcoming";
  const tab = params.get("tab") || "overview";
  const guestStatuses = unique(params.getAll("guest_status").filter((status) => GUEST_STATUSES.has(status) && status !== "all")).slice(0, 20);
  const guestExcludedStatuses = unique(params.getAll("guest_status_not").filter((status) => GUEST_STATUSES.has(status) && status !== "all"))
    .filter((status) => !guestStatuses.includes(status))
    .slice(0, 20);
  const requestedPage = Number.parseInt(params.get("guest_page") || "1", 10);
  const eventIds = unique(params.getAll("event").map((eventId) => boundedText(eventId, 160)).filter(Boolean))
    .slice(0, MAX_SELECTED_EVENT_IDS);

  const guestHasNotes = params.get("guest_has_notes") === "1";
  const guestAttendedGreaterThan = boundedOptionalInteger(params.get("guest_attended_gt"), 0, 10_000);
  return {
    eventId: eventIds.at(-1) || "",
    eventIds,
    eventView: EVENT_VIEWS.has(eventView) ? eventView as WorkspaceUrlState["eventView"] : "upcoming",
    eventSearch: boundedText(params.get("event_search"), 120),
    tab: EVENT_TABS.has(tab) ? tab as WorkspaceUrlState["tab"] : "overview",
    guestStatus: guestStatuses[0] || "all",
    guestStatuses,
    guestStatusMode: params.get("guest_status_mode") === "all" ? "all" : "any",
    guestExcludedStatuses,
    guestSearch: boundedText(params.get("guest_search"), 120),
    guestTags: unique(params.getAll("guest_tag").map((tag) => boundedText(tag, 40)).filter(Boolean)).slice(0, 20),
    guestTagMode: params.get("guest_tag_mode") === "all" ? "all" : "any",
    guestExcludedTags: unique(params.getAll("guest_tag_not").map((tag) => boundedText(tag, 40)).filter(Boolean)).slice(0, 20),
    ...(guestHasNotes ? { guestHasNotes: true } : {}),
    ...(guestAttendedGreaterThan === null ? {} : { guestAttendedGreaterThan }),
    guestPage: Number.isFinite(requestedPage) ? Math.min(100, Math.max(1, requestedPage)) : 1,
    profileId: boundedText(params.get("profile"), 160),
  };
}

export function buildWorkspaceUrlSearch(currentSearch: string, state: WorkspaceUrlState): string {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  WORKSPACE_PARAMS.forEach((key) => params.delete(key));

  const eventIds = unique(state.eventIds?.length ? state.eventIds : state.eventId ? [state.eventId] : []);
  eventIds.forEach((eventId) => params.append("event", eventId));
  if (state.eventView !== "upcoming") params.set("event_view", state.eventView);
  if (state.eventSearch) params.set("event_search", state.eventSearch);
  if (state.tab !== "overview") params.set("tab", state.tab);
  const guestStatuses = unique(state.guestStatuses?.length
    ? state.guestStatuses
    : state.guestStatus !== "all"
      ? [state.guestStatus]
      : []).filter((status) => GUEST_STATUSES.has(status) && status !== "all");
  guestStatuses.forEach((status) => params.append("guest_status", status));
  if (state.guestStatusMode === "all") params.set("guest_status_mode", "all");
  unique(state.guestExcludedStatuses || [])
    .filter((status) => GUEST_STATUSES.has(status) && status !== "all" && !guestStatuses.includes(status))
    .forEach((status) => params.append("guest_status_not", status));
  if (state.guestSearch) params.set("guest_search", state.guestSearch);
  unique(state.guestTags).forEach((tag) => params.append("guest_tag", tag));
  if (state.guestTagMode === "all") params.set("guest_tag_mode", "all");
  unique(state.guestExcludedTags || []).forEach((tag) => params.append("guest_tag_not", tag));
  if (state.guestHasNotes) params.set("guest_has_notes", "1");
  if (state.guestAttendedGreaterThan != null) params.set("guest_attended_gt", String(state.guestAttendedGreaterThan));
  if (state.guestPage > 1) params.set("guest_page", String(Math.floor(state.guestPage)));
  if (state.profileId) params.set("profile", state.profileId);

  return params.toString();
}

function boundedText(value: string | null, maximum: number) {
  return String(value || "").trim().slice(0, maximum);
}

function boundedOptionalInteger(value: string | null, minimum: number, maximum: number) {
  if (value === null || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : null;
}

function unique(values: string[]) {
  return [...new Set(values)];
}
