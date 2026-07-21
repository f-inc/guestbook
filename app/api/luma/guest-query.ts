import { parseTagFilters } from "./person-tags";

export const GUEST_FILTER_VALUES = [
  "all",
  "checked_in",
  "accepted",
  "registered",
  "invited",
  "waitlisted",
  "declined",
  "no_show",
  "new_faces",
] as const;

export type GuestFilter = (typeof GUEST_FILTER_VALUES)[number];

export type GuestListQuery = {
  filter: GuestFilter;
  search: string;
  tags: string[];
  cursor: number;
  pageSize: number;
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
  };
}

export function eventGuestWhere(eventId: string, query: GuestListQuery): Record<string, any> {
  const filters = [guestStatusWhere(eventId, query.filter), guestSearchWhere(query.search), guestTagsWhere(query.tags)].filter(Boolean);
  return {
    eventId,
    ...(filters.length ? { AND: filters } : {}),
  };
}

export function guestStatusWhere(eventId: string, filter: GuestFilter): Record<string, any> | null {
  if (filter === "all") return null;
  if (filter === "accepted") return { status: { in: ["going", "checked_in", "no_show"] } };
  if (filter === "new_faces") {
    return {
      person: {
        is: {
          eventGuests: {
            none: { eventId: { not: eventId } },
          },
        },
      },
    };
  }
  return { status: filter };
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
  return {
    total: guests.length,
    checkedIn: guests.filter((guest) => guest.status === "checked_in").length,
    accepted: guests.filter((guest) => ["going", "checked_in", "no_show"].includes(guest.status)).length,
    registered: guests.filter((guest) => guest.status === "registered").length,
    invited: guests.filter((guest) => guest.status === "invited").length,
    waitlisted: guests.filter((guest) => guest.status === "waitlisted").length,
    newFaces: guests.filter((guest) => guest.isNewFace === true).length,
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
  if (filter === "accepted") return ["going", "checked_in", "no_show"].includes(guest.status);
  if (filter === "new_faces") return guest.isNewFace === true;
  return guest.status === filter;
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
