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
  "new_faces",
] as const;

export const GUEST_REGISTRATION_STATUSES = ["registered", "going", "waitlisted", "checked_in", "declined", "no_show"];
export const GUEST_ACCEPTED_STATUSES = ["going", "checked_in", "no_show"];
export const GUEST_REGISTERED_STATUSES = ["registered", "waitlisted", ...GUEST_ACCEPTED_STATUSES];

export type GuestFilter = (typeof GUEST_FILTER_VALUES)[number];

export type GuestListQuery = {
  filter: GuestFilter;
  search: string;
  tags: string[];
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
  const requestedFilter = params.get("guest_status") || "all";
  const filter = GUEST_FILTER_VALUES.includes(requestedFilter as GuestFilter) ? requestedFilter as GuestFilter : "all";
  return {
    filter,
    search: (params.get("guest_search") || "").trim().slice(0, 120),
    tags: parseTagFilters(params.getAll("guest_tag")),
    cursor: boundedInteger(params.get("guest_cursor"), 0, 0, 1_000_000),
    pageSize: boundedInteger(params.get("guest_limit"), 50, 10, 100),
    includeSummary: params.get("guest_summary") !== "0",
  };
}

export function eventGuestWhere(
  eventId: string,
  query: GuestListQuery,
  boundary?: EventChronologyBoundary | null,
): Record<string, any> {
  const filters = [guestStatusWhere(eventId, query.filter, boundary), guestSearchWhere(query.search), guestTagsWhere(query.tags)].filter(Boolean);
  return {
    eventId,
    ...(filters.length ? { AND: filters } : {}),
  };
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
  if (filter === "registered") return { status: { in: GUEST_REGISTERED_STATUSES } };
  if (filter === "first_registers") {
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
  const peopleById = new Map((payload.people || []).map((person: any) => [person.id, person]));
  const rows = (payload.guests || [])
    .map((guest: any) => ({ guest, person: peopleById.get(guest.personId) }))
    .filter(({ person }: any) => Boolean(person));
  const filteredRows = rows.filter(({ guest, person }: any) => {
    return guestMatchesFilter(guest, query.filter)
      && guestMatchesSearch(guest, person, query.search)
      && guestMatchesTags(person, query.tags);
  });
  const pageRows = filteredRows.slice(query.cursor, query.cursor + query.pageSize);
  const nextCursor = query.cursor + pageRows.length;

  return {
    ...payload,
    guests: pageRows.map(({ guest }: any) => guest),
    people: pageRows.map(({ person }: any) => person),
    stats: summarizeGuests(rows.map(({ guest }: any) => guest)),
    pageInfo: {
      total: filteredRows.length,
      pageSize: query.pageSize,
      hasMore: nextCursor < filteredRows.length,
      nextCursor: nextCursor < filteredRows.length ? String(nextCursor) : null,
    },
    query: { filter: query.filter, search: query.search, tags: query.tags },
  };
}

export function summarizeGuests(guests: any[]) {
  const firstRegisters = guests.filter(isFirstRegister);
  return {
    total: guests.length,
    checkedIn: guests.filter((guest) => guest.status === "checked_in").length,
    accepted: guests.filter((guest) => GUEST_ACCEPTED_STATUSES.includes(guest.status)).length,
    registered: guests.filter((guest) => GUEST_REGISTERED_STATUSES.includes(guest.status)).length,
    invited: guests.filter((guest) => guest.status === "invited").length,
    toDecide: guests.filter((guest) => guest.status === "registered" || (guest.status === "waitlisted" && guest.operatorDecision !== "waitlisted")).length,
    waitlisted: guests.filter((guest) => guest.status === "waitlisted").length,
    firstRegisters: firstRegisters.length,
    newFaces: guests.filter((guest) => guest.status === "checked_in" && isFirstRegistration(guest)).length,
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

function guestTagsWhere(tags: string[]): Record<string, any> | null {
  if (!tags.length) return null;
  return {
    OR: tags.map((tag) => ({
      person: { is: { tags: { array_contains: [tag] } } },
    })),
  };
}

function guestMatchesFilter(guest: any, filter: GuestFilter): boolean {
  if (filter === "all") return true;
  if (filter === "to_decide") {
    return guest.status === "registered"
      || (guest.status === "waitlisted" && guest.operatorDecision !== "waitlisted");
  }
  if (filter === "accepted") return GUEST_ACCEPTED_STATUSES.includes(guest.status);
  if (filter === "registered") return GUEST_REGISTERED_STATUSES.includes(guest.status);
  if (filter === "first_registers") return isFirstRegister(guest);
  if (filter === "new_faces") return guest.status === "checked_in" && isFirstRegistration(guest);
  return guest.status === filter;
}

function isFirstRegister(guest: any): boolean {
  return GUEST_ACCEPTED_STATUSES.includes(guest.status) && isFirstRegistration(guest);
}

function isFirstRegistration(guest: any): boolean {
  return GUEST_REGISTRATION_STATUSES.includes(guest.status)
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

function guestMatchesTags(person: any, tags: string[]): boolean {
  if (!tags.length) return true;
  const personTags = new Set((Array.isArray(person.tags) ? person.tags : []).map((tag: unknown) => String(tag).toLocaleLowerCase()));
  return tags.some((tag) => personTags.has(tag.toLocaleLowerCase()));
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
