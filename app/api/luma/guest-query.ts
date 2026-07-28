import { parseTagFilters } from "./person-tags";

export const GUEST_FILTER_VALUES = [
  "all",
  "to_decide",
  "checked_in",
  "accepted",
  "registered",
  "invited",
  "waitlisted",
  "declined",
  "no_show",
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
] as const;

export const GUEST_REGISTRATION_STATUSES = ["registered", "going", "waitlisted", "checked_in", "declined", "no_show"];
export const GUEST_ACCEPTED_STATUSES = ["going", "checked_in", "no_show"];
export const GUEST_REGISTERED_STATUSES = ["registered", "waitlisted", ...GUEST_ACCEPTED_STATUSES];
const INDEXED_ONLY_GUEST_FILTERS = new Set<GuestFilter>([
  "referrals",
  "new_referrals",
  "invited_referrals",
  "invited_referral_no_response",
  "invited_referral_accepted",
  "invited_referral_declined",
]);

export type GuestFilter = (typeof GUEST_FILTER_VALUES)[number];

export type GuestListQuery = {
  filter: GuestFilter;
  filters?: GuestFilter[];
  filterMode?: "any" | "all";
  excludedFilters?: GuestFilter[];
  search: string;
  tags: string[];
  tagMode?: "any" | "all";
  excludedTags?: string[];
  sortBy?: "status_date" | "events_attended" | "events_registered";
  sortDirection?: "asc" | "desc";
  hasNotes?: boolean;
  attendedGreaterThan?: number | null;
  cursor: number;
  pageSize: number;
  includeSummary?: boolean;
  includeEventCounts?: boolean;
};

export type EventChronologyBoundary = {
  startsAt?: Date | string | null;
  date?: Date | string | null;
};

export function parseGuestListQuery(params: URLSearchParams): GuestListQuery {
  const filters = parseGuestStatusFilters(params.getAll("guest_status"));
  const excludedFilters = parseGuestStatusFilters(params.getAll("guest_status_not"))
    .filter((filter) => !filters.includes(filter));
  const filter = filters[0] || "all";
  const hasNotes = params.get("guest_has_notes") === "1";
  const attendedGreaterThan = optionalBoundedInteger(params.get("guest_attended_gt"), 0, 10_000);
  return {
    filter,
    filters,
    filterMode: params.get("guest_status_mode") === "all" ? "all" : "any",
    excludedFilters,
    search: (params.get("guest_search") || "").trim().slice(0, 120),
    tags: parseTagFilters(params.getAll("guest_tag")),
    tagMode: params.get("guest_tag_mode") === "all" ? "all" : "any",
    excludedTags: parseTagFilters(params.getAll("guest_tag_not")),
    sortBy: ["events_attended", "events_registered"].includes(params.get("guest_sort_by") || "")
      ? params.get("guest_sort_by") as "events_attended" | "events_registered"
      : "status_date",
    sortDirection: params.get("guest_sort") === "asc" ? "asc" : "desc",
    ...(hasNotes ? { hasNotes: true } : {}),
    ...(attendedGreaterThan === null ? {} : { attendedGreaterThan }),
    cursor: boundedInteger(params.get("guest_cursor"), 0, 0, 1_000_000),
    pageSize: boundedInteger(params.get("guest_limit"), 50, 10, 100),
    includeSummary: params.get("guest_summary") !== "0",
  };
}

export function guestFilterRequiresIndex(filter: GuestFilter): boolean {
  return INDEXED_ONLY_GUEST_FILTERS.has(filter);
}

export function guestQueryRequiresIndex(query: GuestListQuery): boolean {
  return guestQueryStatusFilters(query).some(guestFilterRequiresIndex)
    || query.sortBy === "events_attended"
    || query.sortBy === "events_registered"
    || query.sortDirection === "asc"
    || Boolean(query.hasNotes)
    || query.attendedGreaterThan != null;
}

export function eventGuestWhere(
  eventId: string,
  query: GuestListQuery,
  boundary?: EventChronologyBoundary | null,
): Record<string, any> {
  const filters = [
    guestStatusRulesWhere(eventId, query, boundary),
    guestSearchWhere(query.search),
    guestTagsWhere(query.tags, query.tagMode, query.excludedTags),
    query.hasNotes ? { person: { is: { comments: { some: {} } } } } : null,
  ].filter(Boolean);
  return {
    eventId,
    ...(filters.length ? { AND: filters } : {}),
  };
}

export function guestQueryIncludedStatusFilters(query: GuestListQuery): GuestFilter[] {
  if (Array.isArray(query.filters)) return query.filters.filter((filter) => filter !== "all");
  return query.filter === "all" ? [] : [query.filter];
}

export function guestQueryStatusFilters(query: GuestListQuery): GuestFilter[] {
  return [...new Set([
    ...guestQueryIncludedStatusFilters(query),
    ...(query.excludedFilters || []).filter((filter) => filter !== "all"),
  ])];
}

export function guestStatusRulesWhere(
  eventId: string,
  query: GuestListQuery,
  boundary?: EventChronologyBoundary | null,
): Record<string, any> | null {
  const included = guestQueryIncludedStatusFilters(query)
    .map((filter) => guestStatusWhere(eventId, filter, boundary))
    .filter(Boolean) as Record<string, any>[];
  const excluded = (query.excludedFilters || [])
    .filter((filter) => filter !== "all")
    .map((filter) => guestStatusWhere(eventId, filter, boundary))
    .filter(Boolean) as Record<string, any>[];
  const predicates: Record<string, any>[] = [];
  if (included.length) {
    predicates.push(included.length === 1
      ? included[0]
      : { [query.filterMode === "all" ? "AND" : "OR"]: included });
  }
  predicates.push(...excluded.map((predicate) => ({ NOT: predicate })));
  if (!predicates.length) return null;
  return predicates.length === 1 ? predicates[0] : { AND: predicates };
}

export function guestStatusWhere(
  eventId: string,
  filter: GuestFilter,
  boundary?: EventChronologyBoundary | null,
): Record<string, any> | null {
  if (filter === "all") return null;
  if (filter === "to_decide") {
    return {
      OR: [
        { status: "registered" },
        {
          AND: [
            { status: "waitlisted" },
            { OR: [{ operatorDecision: null }, { operatorDecision: { not: "waitlisted" } }] },
          ],
        },
      ],
    };
  }
  if (filter === "accepted") return { status: { in: GUEST_ACCEPTED_STATUSES } };
  if (filter === "registered") return registeredGuestWhere();
  if (filter === "invited") return { OR: [{ invitedAt: { not: null } }, { status: "invited" }] };
  if (filter === "invited_no_response") return { status: "invited" };
  if (filter === "invited_accepted") {
    return {
      OR: [{ checkedInAt: { not: null } }, { status: { in: GUEST_ACCEPTED_STATUSES } }],
    };
  }
  if (filter === "invited_going") return { status: "going" };
  if (filter === "invited_checked_in") {
    return { OR: [{ checkedInAt: { not: null } }, { status: "checked_in" }] };
  }
  if (filter === "invited_no_show") return { status: "no_show" };
  if (filter === "invited_declined") return { status: "declined" };
  if (filter === "referrals" || filter.startsWith("invited_referral_")) {
    const cohort = filter === "referrals"
      ? { OR: [{ checkedInAt: { not: null } }, { status: "checked_in" }] }
      : filter === "invited_referral_no_response"
        ? { status: "invited" }
        : filter === "invited_referral_accepted"
          ? { OR: [{ checkedInAt: { not: null } }, { status: { in: GUEST_ACCEPTED_STATUSES } }] }
          : { status: "declined" };
    return { AND: [cohort, activeReferralWhere()] };
  }
  if (filter === "invited_referrals") return { AND: [invitationEvidenceWhere(), activeReferralWhere()] };
  if (filter === "first_registers") return { AND: [registeredGuestWhere(), firstRegistrationPersonWhere(eventId, boundary)] };
  if (filter === "accepted_first_registers") {
    return { AND: [{ status: { in: GUEST_ACCEPTED_STATUSES } }, firstRegistrationPersonWhere(eventId, boundary)] };
  }
  if (filter === "new_faces") return { AND: [{ status: "checked_in" }, firstRegistrationPersonWhere(eventId, boundary)] };
  return { status: filter };
}

export function priorEventWhere(boundary?: EventChronologyBoundary | null): Record<string, any> | null {
  const startsAt = validDate(boundary?.startsAt);
  const date = validDate(boundary?.date);
  if (startsAt) {
    return {
      OR: [
        { startsAt: { lt: startsAt } },
        ...(date ? [{ startsAt: null, date: { lt: date } }] : []),
      ],
    };
  }
  return date ? { date: { lt: date } } : null;
}

export function filterGuestPayload(payload: any, query: GuestListQuery) {
  const {
    stats: cachedStats,
    analyticsQuestions: cachedAnalyticsQuestions,
    ...payloadWithoutSummary
  } = payload;
  const peopleById = new Map((payload.people || []).map((person: any) => [person.id, person]));
  const rows = (payload.guests || [])
    .map((guest: any) => ({ guest, person: peopleById.get(guest.personId) }))
    .filter(({ person }: any) => Boolean(person));
  const filteredRows = rows.filter(({ guest, person }: any) => {
    return guestMatchesStatusRules(guest, query)
      && guestMatchesSearch(guest, person, query.search)
      && guestMatchesTags(person, query.tags, query.tagMode, query.excludedTags)
      && (!query.hasNotes || Number(person.crmNoteCount || 0) > 0 || Boolean(person.crmNotes?.trim()))
      && (query.attendedGreaterThan == null || Number(guest.eventCounts?.attended) > query.attendedGreaterThan);
  });
  if (isOnlyInvitedStatusFilter(query)) {
    filteredRows.sort(({ guest: left }: any, { guest: right }: any) => invitationCohortSortRank(left) - invitationCohortSortRank(right));
  }
  const pageRows = filteredRows.slice(query.cursor, query.cursor + query.pageSize);
  const nextCursor = query.cursor + pageRows.length;

  return {
    ...payloadWithoutSummary,
    guests: pageRows.map(({ guest }: any) => guest),
    people: pageRows.map(({ person }: any) => person),
    ...(query.includeSummary === false
      ? {}
      : {
          stats: cachedStats || summarizeGuests(rows.map(({ guest }: any) => guest)),
          ...(cachedAnalyticsQuestions === undefined ? {} : { analyticsQuestions: cachedAnalyticsQuestions }),
        }),
    pageInfo: {
      total: filteredRows.length,
      pageSize: query.pageSize,
      hasMore: nextCursor < filteredRows.length,
      nextCursor: nextCursor < filteredRows.length ? String(nextCursor) : null,
    },
    query: {
      filter: query.filter,
      filters: guestQueryIncludedStatusFilters(query),
      filterMode: query.filterMode || "any",
      excludedFilters: query.excludedFilters || [],
      search: query.search,
      tags: query.tags,
      tagMode: query.tagMode || "any",
      excludedTags: query.excludedTags || [],
      sortBy: query.sortBy || "status_date",
      sortDirection: query.sortDirection || "desc",
      hasNotes: query.hasNotes,
      attendedGreaterThan: query.attendedGreaterThan,
    },
  };
}

export function isOnlyInvitedStatusFilter(query: GuestListQuery): boolean {
  const included = guestQueryIncludedStatusFilters(query);
  return included.length === 1 && included[0] === "invited" && !(query.excludedFilters || []).length;
}

export function summarizeGuests(guests: any[]) {
  const firstRegisters = guests.filter(isFirstRegister);
  const newRegistrations = guests.filter((guest) => isRegisteredGuest(guest) && isFirstRegistration(guest));
  return {
    total: guests.length,
    checkedIn: guests.filter((guest) => guest.status === "checked_in").length,
    accepted: guests.filter((guest) => GUEST_ACCEPTED_STATUSES.includes(guest.status)).length,
    registered: guests.filter(isRegisteredGuest).length,
    pending: guests.filter((guest) => guest.status === "registered").length,
    declined: guests.filter((guest) => guest.status === "declined").length,
    invited: guests.filter(hasInvitationEvidence).length,
    invitedNoResponse: guests.filter((guest) => guest.status === "invited").length,
    toDecide: guests.filter((guest) => guest.status === "registered" || (guest.status === "waitlisted" && guest.operatorDecision !== "waitlisted")).length,
    waitlisted: guests.filter((guest) => guest.status === "waitlisted").length,
    firstRegisters: firstRegisters.length,
    newRegistrations: newRegistrations.length,
    newFaces: guests.filter((guest) => guest.status === "checked_in" && isFirstRegistration(guest)).length,
    newReferrals: guests.filter((guest) => guest.isReferred && guest.isNewReferral && (Boolean(guest.checkedInAt) || guest.status === "checked_in")).length,
  };
}

function firstRegistrationPersonWhere(eventId: string, boundary?: EventChronologyBoundary | null): Record<string, any> {
  const priorEvent = priorEventWhere(boundary);
  return {
    person: {
      is: {
        eventGuests: {
          none: {
            eventId: { not: eventId },
            ...(priorEvent ? { event: { is: priorEvent } } : {}),
          },
        },
      },
    },
  };
}

function guestSearchWhere(search: string): Record<string, any> | null {
  if (!search) return null;
  const contains = { contains: search, mode: "insensitive" };
  return {
    OR: [
      { searchText: contains },
      { profileDescription: contains },
      { email: contains },
      {
        person: {
          is: {
            OR: [
              { name: contains },
              { email: contains },
              { title: contains },
              { bio: contains },
            ],
          },
        },
      },
    ],
  };
}

function guestTagsWhere(
  tags: string[],
  tagMode: "any" | "all" = "any",
  excludedTags: string[] = [],
): Record<string, any> | null {
  const tagPredicate = (tag: string) => ({
    person: { is: { tags: { array_contains: [tag] } } },
  });
  const predicates: Record<string, any>[] = [];
  if (tags.length) {
    predicates.push({
      [tagMode === "all" ? "AND" : "OR"]: tags.map(tagPredicate),
    });
  }
  predicates.push(...excludedTags.map((tag) => ({ NOT: tagPredicate(tag) })));
  if (!predicates.length) return null;
  return predicates.length === 1 ? predicates[0] : { AND: predicates };
}

function guestMatchesFilter(guest: any, filter: GuestFilter): boolean {
  if (filter === "all") return true;
  if (filter === "to_decide") {
    return guest.status === "registered"
      || (guest.status === "waitlisted" && guest.operatorDecision !== "waitlisted");
  }
  if (filter === "accepted") return GUEST_ACCEPTED_STATUSES.includes(guest.status);
  if (filter === "registered") return isRegisteredGuest(guest);
  if (filter === "invited") return hasInvitationEvidence(guest);
  if (filter === "invited_no_response") return guest.status === "invited";
  if (filter === "invited_accepted") return Boolean(guest.checkedInAt) || GUEST_ACCEPTED_STATUSES.includes(guest.status);
  if (filter === "invited_going") return guest.status === "going";
  if (filter === "invited_checked_in") return Boolean(guest.checkedInAt) || guest.status === "checked_in";
  if (filter === "invited_no_show") return guest.status === "no_show";
  if (filter === "invited_declined") return guest.status === "declined";
  if (filter === "referrals") return Boolean(guest.isReferred) && (Boolean(guest.checkedInAt) || guest.status === "checked_in");
  if (filter === "invited_referrals") return Boolean(guest.isReferred) && hasInvitationEvidence(guest);
  if (filter === "invited_referral_no_response") return Boolean(guest.isReferred) && guest.status === "invited";
  if (filter === "invited_referral_accepted") return Boolean(guest.isReferred) && (Boolean(guest.checkedInAt) || GUEST_ACCEPTED_STATUSES.includes(guest.status));
  if (filter === "invited_referral_declined") return Boolean(guest.isReferred) && guest.status === "declined";
  if (filter === "first_registers") return isRegisteredGuest(guest) && isFirstRegistration(guest);
  if (filter === "accepted_first_registers") return isFirstRegister(guest);
  if (filter === "new_faces") return guest.status === "checked_in" && isFirstRegistration(guest);
  if (filter === "new_referrals") return Boolean(guest.isReferred && guest.isNewReferral) && (Boolean(guest.checkedInAt) || guest.status === "checked_in");
  return guest.status === filter;
}

function guestMatchesStatusRules(guest: any, query: GuestListQuery): boolean {
  const included = guestQueryIncludedStatusFilters(query);
  const includedMatch = !included.length
    || (query.filterMode === "all"
      ? included.every((filter) => guestMatchesFilter(guest, filter))
      : included.some((filter) => guestMatchesFilter(guest, filter)));
  return includedMatch
    && !(query.excludedFilters || []).some((filter) => guestMatchesFilter(guest, filter));
}

export function hasInvitationEvidence(guest: any): boolean {
  return Boolean(guest?.invitedAt) || guest?.status === "invited";
}

export function isRegisteredGuest(guest: any): boolean {
  return GUEST_REGISTERED_STATUSES.includes(guest?.status)
    || (guest?.status === "declined" && Boolean(guest?.registeredAt));
}

export function registeredGuestWhere() {
  return {
    OR: [
      { status: { in: GUEST_REGISTERED_STATUSES } },
      { status: "declined", registeredAt: { not: null } },
    ],
  };
}

function invitationEvidenceWhere() {
  return { OR: [{ invitedAt: { not: null } }, { status: "invited" }] };
}

function activeReferralWhere() {
  return {
    person: {
      is: {
        manualTagMutations: {
          some: {
            removed: false,
            tag: { is: { semanticKey: "referral" } },
          },
        },
      },
    },
  };
}

export function invitationCohortSortRank(guest: any): number {
  if (GUEST_ACCEPTED_STATUSES.includes(guest?.status)) return 0;
  if (guest?.status === "invited") return 1;
  return 2;
}

function isFirstRegister(guest: any): boolean {
  return GUEST_ACCEPTED_STATUSES.includes(guest.status) && isFirstRegistration(guest);
}

function isFirstRegistration(guest: any): boolean {
  return isRegisteredGuest(guest)
    && (guest.isFirstRegistration === true || guest.isNewFace === true);
}

function guestMatchesSearch(guest: any, person: any, search: string): boolean {
  if (!search) return true;
  const query = search.toLowerCase();
  return [person.name, person.email, person.title, person.bio, guest.profileDescription, guest.searchText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function guestMatchesTags(
  person: any,
  tags: string[],
  tagMode: "any" | "all" = "any",
  excludedTags: string[] = [],
): boolean {
  const personTags = new Set((Array.isArray(person.tags) ? person.tags : []).map((tag: unknown) => String(tag).toLocaleLowerCase()));
  if (excludedTags.some((tag) => personTags.has(tag.toLocaleLowerCase()))) return false;
  if (!tags.length) return true;
  return tagMode === "all"
    ? tags.every((tag) => personTags.has(tag.toLocaleLowerCase()))
    : tags.some((tag) => personTags.has(tag.toLocaleLowerCase()));
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalBoundedInteger(value: string | null, min: number, max: number): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

function parseGuestStatusFilters(values: string[]): GuestFilter[] {
  return [...new Set(values
    .filter((value): value is GuestFilter => GUEST_FILTER_VALUES.includes(value as GuestFilter))
    .filter((value) => value !== "all"))]
    .slice(0, 20);
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
