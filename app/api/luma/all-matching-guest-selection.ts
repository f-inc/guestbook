import { GUEST_FILTER_VALUES, parseGuestListQuery, type GuestListQuery } from "./guest-query";
import { normalizeMultiEventIds } from "./multi-event-stats";

type AllMatchingGuestQueryInput = {
  guestStatus?: unknown;
  guestSearch?: unknown;
  guestTags?: unknown;
  guestHasNotes?: unknown;
  guestAttendedGreaterThan?: unknown;
};

export function parseAllMatchingGuestQuery(input: AllMatchingGuestQueryInput = {}): GuestListQuery {
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
  if (input.guestHasNotes !== undefined && typeof input.guestHasNotes !== "boolean") {
    throw badRequest("Guest notes filter must be a boolean.");
  }
  if (input.guestAttendedGreaterThan !== undefined
    && input.guestAttendedGreaterThan !== null
    && (!Number.isInteger(input.guestAttendedGreaterThan) || Number(input.guestAttendedGreaterThan) < 0)) {
    throw badRequest("Events attended filter must be a non-negative integer.");
  }

  const params = new URLSearchParams({
    guest_status: input.guestStatus,
    guest_search: typeof input.guestSearch === "string" ? input.guestSearch : "",
    guest_limit: "100",
    guest_summary: "0",
  });
  for (const tag of Array.isArray(input.guestTags) ? input.guestTags : []) params.append("guest_tag", tag);
  if (input.guestHasNotes) params.set("guest_has_notes", "1");
  if (input.guestAttendedGreaterThan !== undefined && input.guestAttendedGreaterThan !== null) {
    params.set("guest_attended_gt", String(input.guestAttendedGreaterThan));
  }
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
