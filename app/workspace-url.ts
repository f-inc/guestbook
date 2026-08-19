import { MAX_SELECTED_EVENT_IDS } from "./event-selection";

export const EVENT_DIRECTORY_PATH = "/events";
export const WORKSPACE_SCROLL_HISTORY_KEY = "guestbookWorkspaceScrollTop";
export type EventDirectorySortKey = "title" | "date" | "newFaces" | "discoveryRate" | "newReferrals" | "checkedIn" | "showRate" | "firstRegisters" | "accepted" | "registered" | "invited" | "waitlisted" | "averageRating" | "modifiedAt";
export type EventDirectoryMetricKey = "newFaces" | "discoveryRate" | "newReferrals" | "checkedIn" | "showRate" | "firstRegisters" | "accepted" | "registered" | "invited" | "waitlisted";
export type EventDirectoryMetricFilter = { key: EventDirectoryMetricKey; operator: "gte" | "lte"; value: number };
export type WorkspaceGuestAnswerGroup = { question: string; answer: string; answerKey: string; checkedInOnly: boolean };

const EVENT_DIRECTORY_SORT_PARAMS: Record<EventDirectorySortKey, string> = {
  title: "title",
  date: "date",
  newFaces: "new_faces",
  discoveryRate: "discovery_rate",
  newReferrals: "new_referrals",
  checkedIn: "check_ins",
  showRate: "show_rate",
  firstRegisters: "first_registers",
  accepted: "accepted",
  registered: "registered",
  invited: "invited",
  waitlisted: "waitlist",
  averageRating: "average_rating",
  modifiedAt: "modified_at",
};
const EVENT_DIRECTORY_SORT_KEYS = new Map(
  Object.entries(EVENT_DIRECTORY_SORT_PARAMS).map(([key, value]) => [value, key as EventDirectorySortKey]),
);
const EVENT_DIRECTORY_METRIC_KEYS = new Set<EventDirectoryMetricKey>([
  "newFaces",
  "discoveryRate",
  "newReferrals",
  "checkedIn",
  "showRate",
  "firstRegisters",
  "accepted",
  "registered",
  "invited",
  "waitlisted",
]);

export function isEventDirectoryPath(pathname: string) {
  return pathname === EVENT_DIRECTORY_PATH || pathname === `${EVENT_DIRECTORY_PATH}/`;
}

export function workspacePathname(eventDirectoryOpen: boolean) {
  return eventDirectoryOpen ? EVENT_DIRECTORY_PATH : "/";
}

export function workspaceHistoryStateWithScroll(currentState: unknown, scrollTop: number) {
  const state = currentState && typeof currentState === "object" && !Array.isArray(currentState)
    ? currentState as Record<string, unknown>
    : {};
  const normalizedScrollTop = Number.isFinite(scrollTop) ? Math.max(0, Math.round(scrollTop)) : 0;
  return { ...state, [WORKSPACE_SCROLL_HISTORY_KEY]: normalizedScrollTop };
}

export function workspaceScrollTopFromHistoryState(state: unknown): number | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = Number((state as Record<string, unknown>)[WORKSPACE_SCROLL_HISTORY_KEY]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export type WorkspaceUrlState = {
  eventId: string;
  eventIds: string[];
  eventView: "upcoming" | "past" | "all";
  eventSearch: string;
  eventSort?: EventDirectorySortKey;
  eventSortDirection?: "asc" | "desc";
  eventTitleIncludes?: string;
  eventTitleExcludes?: string;
  eventMetricFilters?: EventDirectoryMetricFilter[];
  tab: "overview" | "invite" | "analytics" | "feedback";
  analyticsCohort?: "all" | "first_registers";
  guestStatus: string;
  guestStatuses?: string[];
  guestStatusMode?: "any" | "all";
  guestExcludedStatuses?: string[];
  guestSearch: string;
  guestTags: string[];
  guestTagMode?: "any" | "all";
  guestExcludedTags?: string[];
  guestLatestTagId?: string;
  guestLatestTagLabel?: string;
  guestHasNotes?: boolean;
  guestAttendedGreaterThan?: number | null;
  guestAnswerQuestion?: string;
  guestAnswer?: string;
  guestAnswerKey?: string;
  guestAnswerGroups?: WorkspaceGuestAnswerGroup[];
  guestPage: number;
  profileId: string;
};

const EVENT_VIEWS = new Set(["upcoming", "past", "all"]);
const EVENT_TABS = new Set(["overview", "invite", "analytics", "feedback"]);
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
  "sort",
  "direction",
  "event_title_includes",
  "event_title_excludes",
  "event_metric",
  "tab",
  "analytics_cohort",
  "guest_status",
  "guest_status_mode",
  "guest_status_not",
  "guest_search",
  "guest_tag",
  "guest_tag_mode",
  "guest_tag_not",
  "guest_latest_tag_id",
  "guest_latest_tag_label",
  "guest_has_notes",
  "guest_attended_gt",
  "guest_answer_question",
  "guest_answer",
  "guest_answer_key",
  "guest_answer_group",
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
  const eventSort = EVENT_DIRECTORY_SORT_KEYS.get(params.get("sort") || "");
  const eventSortDirection = params.get("direction") === "asc" ? "asc" : "desc";
  const eventMetricFilters = params.getAll("event_metric")
    .map(parseEventDirectoryMetricFilter)
    .filter((filter): filter is EventDirectoryMetricFilter => Boolean(filter))
    .slice(0, 12);
  const eventTitleIncludes = boundedText(params.get("event_title_includes"), 240);
  const eventTitleExcludes = boundedText(params.get("event_title_excludes"), 240);

  const guestHasNotes = params.get("guest_has_notes") === "1";
  const guestAttendedGreaterThan = boundedOptionalInteger(params.get("guest_attended_gt"), 0, 10_000);
  const guestAnswerQuestion = boundedText(params.get("guest_answer_question"), 500);
  const guestLatestTagId = boundedText(params.get("guest_latest_tag_id"), 200);
  const guestLatestTagLabel = boundedText(params.get("guest_latest_tag_label"), 80);
  const guestAnswerGroups = params.getAll("guest_answer_group")
    .map(parseWorkspaceGuestAnswerGroup)
    .filter((group): group is WorkspaceGuestAnswerGroup => Boolean(group))
    .slice(0, 40);
  return {
    eventId: eventIds.at(-1) || "",
    eventIds,
    eventView: EVENT_VIEWS.has(eventView) ? eventView as WorkspaceUrlState["eventView"] : "upcoming",
    eventSearch: boundedText(params.get("event_search"), 120),
    ...(eventSort ? { eventSort, eventSortDirection } : {}),
    ...(eventTitleIncludes ? { eventTitleIncludes } : {}),
    ...(eventTitleExcludes ? { eventTitleExcludes } : {}),
    ...(eventMetricFilters.length ? { eventMetricFilters } : {}),
    tab: EVENT_TABS.has(tab) ? tab as WorkspaceUrlState["tab"] : "overview",
    analyticsCohort: params.get("analytics_cohort") === "first_registers" ? "first_registers" : "all",
    guestStatus: guestStatuses[0] || "all",
    guestStatuses,
    guestStatusMode: params.get("guest_status_mode") === "all" ? "all" : "any",
    guestExcludedStatuses,
    guestSearch: boundedText(params.get("guest_search"), 120),
    guestTags: unique(params.getAll("guest_tag").map((tag) => boundedText(tag, 40)).filter(Boolean)).slice(0, 20),
    guestTagMode: params.get("guest_tag_mode") === "all" ? "all" : "any",
    guestExcludedTags: unique(params.getAll("guest_tag_not").map((tag) => boundedText(tag, 40)).filter(Boolean)).slice(0, 20),
    ...(guestLatestTagId ? { guestLatestTagId, guestLatestTagLabel } : {}),
    ...(guestHasNotes ? { guestHasNotes: true } : {}),
    ...(guestAttendedGreaterThan === null ? {} : { guestAttendedGreaterThan }),
    ...(guestAnswerGroups.length ? { guestAnswerGroups } : guestAnswerQuestion ? {
      guestAnswerQuestion,
      guestAnswer: boundedText(params.get("guest_answer"), 500),
      guestAnswerKey: boundedText(params.get("guest_answer_key"), 500),
    } : {}),
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
  const eventSort = state.eventSort || "date";
  const eventSortDirection = state.eventSortDirection === "asc" ? "asc" : "desc";
  if (eventSort !== "date" || eventSortDirection !== "desc") {
    params.set("sort", EVENT_DIRECTORY_SORT_PARAMS[eventSort]);
    params.set("direction", eventSortDirection);
  }
  if (state.eventTitleIncludes) params.set("event_title_includes", state.eventTitleIncludes);
  if (state.eventTitleExcludes) params.set("event_title_excludes", state.eventTitleExcludes);
  (state.eventMetricFilters || []).slice(0, 12).forEach((filter) => {
    if (!EVENT_DIRECTORY_METRIC_KEYS.has(filter.key) || !["gte", "lte"].includes(filter.operator) || !Number.isFinite(filter.value) || filter.value < 0) return;
    params.append("event_metric", `${filter.key}:${filter.operator}:${filter.value}`);
  });
  if (state.tab !== "overview") params.set("tab", state.tab);
  if (state.analyticsCohort === "first_registers") params.set("analytics_cohort", "first_registers");
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
  if (state.guestLatestTagId) {
    params.set("guest_latest_tag_id", state.guestLatestTagId);
    if (state.guestLatestTagLabel) params.set("guest_latest_tag_label", state.guestLatestTagLabel);
  }
  if (state.guestHasNotes) params.set("guest_has_notes", "1");
  if (state.guestAttendedGreaterThan != null) params.set("guest_attended_gt", String(state.guestAttendedGreaterThan));
  if (state.guestAnswerGroups?.length) {
    state.guestAnswerGroups.slice(0, 40).forEach((group) => params.append("guest_answer_group", JSON.stringify(group)));
  } else {
    if (state.guestAnswerQuestion) params.set("guest_answer_question", state.guestAnswerQuestion);
    if (state.guestAnswer) params.set("guest_answer", state.guestAnswer);
    if (state.guestAnswerKey) params.set("guest_answer_key", state.guestAnswerKey);
  }
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

function parseWorkspaceGuestAnswerGroup(value: string): WorkspaceGuestAnswerGroup | null {
  try {
    const candidate = JSON.parse(value);
    const question = boundedText(candidate?.question, 500);
    if (!question) return null;
    return {
      question,
      answer: boundedText(candidate?.answer, 500),
      answerKey: boundedText(candidate?.answerKey, 500),
      checkedInOnly: candidate?.checkedInOnly === true,
    };
  } catch {
    return null;
  }
}

function parseEventDirectoryMetricFilter(value: string): EventDirectoryMetricFilter | null {
  const [key, operator, rawValue, ...rest] = value.split(":");
  if (rest.length || !EVENT_DIRECTORY_METRIC_KEYS.has(key as EventDirectoryMetricKey) || !["gte", "lte"].includes(operator)) return null;
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1_000_000_000) return null;
  return { key: key as EventDirectoryMetricKey, operator: operator as "gte" | "lte", value: numericValue };
}

function unique(values: string[]) {
  return [...new Set(values)];
}
