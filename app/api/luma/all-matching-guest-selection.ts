import { GUEST_FILTER_VALUES, parseGuestListQuery, type GuestListQuery } from "./guest-query";
import { normalizeMultiEventIds } from "./multi-event-stats";

type AllMatchingGuestQueryInput = {
  guestStatus?: unknown;
  guestStatuses?: unknown;
  guestStatusMode?: unknown;
  guestExcludedStatuses?: unknown;
  guestSearch?: unknown;
  guestTags?: unknown;
  guestTagMode?: unknown;
  guestExcludedTags?: unknown;
  guestHasNotes?: unknown;
  guestAttendedGreaterThan?: unknown;
  guestAnswerQuestion?: unknown;
  guestAnswer?: unknown;
  guestAnswerKey?: unknown;
};

export function parseAllMatchingGuestQuery(input: AllMatchingGuestQueryInput = {}): GuestListQuery {
  if (input.guestStatuses !== undefined && !Array.isArray(input.guestStatuses)) {
    throw badRequest("Guest statuses must be an array.");
  }
  if (Array.isArray(input.guestStatuses) && input.guestStatuses.some((status) => typeof status !== "string" || !GUEST_FILTER_VALUES.includes(status as never))) {
    throw badRequest("Every included guest status must be valid.");
  }
  if (input.guestStatusMode !== undefined && !["any", "all"].includes(String(input.guestStatusMode))) {
    throw badRequest("Guest status mode must be any or all.");
  }
  if (input.guestExcludedStatuses !== undefined && !Array.isArray(input.guestExcludedStatuses)) {
    throw badRequest("Excluded guest statuses must be an array.");
  }
  if (Array.isArray(input.guestExcludedStatuses) && input.guestExcludedStatuses.some((status) => typeof status !== "string" || !GUEST_FILTER_VALUES.includes(status as never))) {
    throw badRequest("Every excluded guest status must be valid.");
  }
  if (typeof input.guestStatus !== "string" || !GUEST_FILTER_VALUES.includes(input.guestStatus as never)) {
    throw badRequest("A valid guest status filter is required for an all-matching update.");
  }
  if (input.guestSearch !== undefined && typeof input.guestSearch !== "string") {
    throw badRequest("Guest search must be a string.");
  }
  if (input.guestTags !== undefined && !Array.isArray(input.guestTags)) {
    throw badRequest("Guest tags must be an array.");
  }
  if (Array.isArray(input.guestTags) && input.guestTags.some((tag) => typeof tag !== "string")) {
    throw badRequest("Every guest tag must be a string.");
  }
  if (input.guestTagMode !== undefined && !["any", "all"].includes(String(input.guestTagMode))) {
    throw badRequest("Guest tag mode must be any or all.");
  }
  if (input.guestExcludedTags !== undefined && !Array.isArray(input.guestExcludedTags)) {
    throw badRequest("Excluded guest tags must be an array.");
  }
  if (Array.isArray(input.guestExcludedTags) && input.guestExcludedTags.some((tag) => typeof tag !== "string")) {
    throw badRequest("Every excluded guest tag must be a string.");
  }
  if (input.guestHasNotes !== undefined && typeof input.guestHasNotes !== "boolean") {
    throw badRequest("Guest notes filter must be a boolean.");
  }
  if (input.guestAttendedGreaterThan !== undefined
    && input.guestAttendedGreaterThan !== null
    && (!Number.isInteger(input.guestAttendedGreaterThan) || Number(input.guestAttendedGreaterThan) < 0)) {
    throw badRequest("Events attended filter must be a non-negative integer.");
  }
  for (const [value, label] of [
    [input.guestAnswerQuestion, "Guest answer question"],
    [input.guestAnswer, "Guest answer"],
    [input.guestAnswerKey, "Guest answer key"],
  ] as const) {
    if (value !== undefined && typeof value !== "string") throw badRequest(`${label} must be a string.`);
  }

  const params = new URLSearchParams({
    guest_search: typeof input.guestSearch === "string" ? input.guestSearch : "",
    guest_limit: "100",
    guest_summary: "0",
  });
  const includedStatuses = Array.isArray(input.guestStatuses)
    ? input.guestStatuses
    : input.guestStatus === "all"
      ? []
      : [input.guestStatus];
  for (const status of includedStatuses) {
    if (status !== "all") params.append("guest_status", status);
  }
  if (input.guestStatusMode === "all") params.set("guest_status_mode", "all");
  for (const status of Array.isArray(input.guestExcludedStatuses) ? input.guestExcludedStatuses : []) {
    if (status !== "all") params.append("guest_status_not", status);
  }
  for (const tag of Array.isArray(input.guestTags) ? input.guestTags : []) params.append("guest_tag", tag);
  if (input.guestTagMode === "all") params.set("guest_tag_mode", "all");
  for (const tag of Array.isArray(input.guestExcludedTags) ? input.guestExcludedTags : []) params.append("guest_tag_not", tag);
  if (input.guestHasNotes) params.set("guest_has_notes", "1");
  if (input.guestAttendedGreaterThan !== undefined && input.guestAttendedGreaterThan !== null) {
    params.set("guest_attended_gt", String(input.guestAttendedGreaterThan));
  }
  if (typeof input.guestAnswerQuestion === "string" && input.guestAnswerQuestion) params.set("guest_answer_question", input.guestAnswerQuestion);
  if (typeof input.guestAnswer === "string" && input.guestAnswer) params.set("guest_answer", input.guestAnswer);
  if (typeof input.guestAnswerKey === "string" && input.guestAnswerKey) params.set("guest_answer_key", input.guestAnswerKey);
  return parseGuestListQuery(params);
}

export function parseAllMatchingEventIds(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw badRequest("At least one event is required for an all-matching update.");
  const eventIds = normalizeMultiEventIds(value);
  if (!eventIds.length || eventIds.length !== new Set(value).size) {
    throw badRequest("Every all-matching event id must be valid.");
  }
  return eventIds;
}

function badRequest(message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = 400;
  return error;
}
