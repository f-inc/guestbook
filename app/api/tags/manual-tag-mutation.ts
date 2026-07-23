import { parseAllMatchingEventIds, parseAllMatchingGuestQuery } from "../luma/all-matching-guest-selection";
import type { GuestListQuery } from "../luma/guest-query";

type ManualTagMutationInput = {
  personId?: unknown;
  tagId?: unknown;
  eventId?: unknown;
  removed?: unknown;
};

type BulkManualTagMutationInput = {
  allMatching?: unknown;
  eventIds?: unknown;
  guestStatus?: unknown;
  guestSearch?: unknown;
  guestTags?: unknown;
  guestHasNotes?: unknown;
  guestAttendedGreaterThan?: unknown;
  people?: unknown;
  tagIds?: unknown;
  removed?: unknown;
};

export const MAX_BULK_TAG_PEOPLE = 500;
export const MAX_ALL_MATCHING_TAG_PEOPLE = 5000;
export const MAX_BULK_TAG_IDS = 30;
export const MAX_BULK_TAG_MUTATIONS = 5_000;
export const MAX_ALL_MATCHING_TAG_MUTATIONS = 50_000;

export type ManualTagMutation = {
  personId: string;
  tagId: string;
  eventId: string;
  removed: boolean;
};

export type BulkManualTagMutation = {
  people: Array<{ personId: string; eventId: string }>;
  tagIds: string[];
  removed: boolean;
} | {
  allMatching: true;
  eventIds: string[];
  query: GuestListQuery;
  tagIds: string[];
  removed: boolean;
};

export function parseManualTagMutation(input: ManualTagMutationInput = {}): ManualTagMutation {
  const personId = identifier(input.personId, "A person id is required.");
  const tagId = identifier(input.tagId, "A tag id is required.");
  const eventId = identifier(input.eventId, "An event id is required.");
  if (typeof input.removed !== "boolean") throw badRequest("Removed must be a boolean.");
  return { personId, tagId, eventId, removed: input.removed };
}

export function parseBulkManualTagMutation(input: BulkManualTagMutationInput = {}): BulkManualTagMutation {
  if (!Array.isArray(input.tagIds) || !input.tagIds.length) throw badRequest("Select at least one tag.");
  if (input.tagIds.length > MAX_BULK_TAG_IDS) {
    throw badRequest(`Bulk tag changes support up to ${MAX_BULK_TAG_IDS} tags at a time.`);
  }
  if (typeof input.removed !== "boolean") throw badRequest("Removed must be a boolean.");

  const tagIds = input.tagIds.map((tagId) => identifier(tagId, "A tag id is required."));
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length !== tagIds.length) throw badRequest("Each selected tag can appear only once.");

  if (input.allMatching === true) {
    return {
      allMatching: true,
      eventIds: parseAllMatchingEventIds(input.eventIds),
      query: parseAllMatchingGuestQuery(input),
      tagIds,
      removed: input.removed,
    };
  }

  if (!Array.isArray(input.people) || !input.people.length) throw badRequest("Select at least one guest.");
  if (input.people.length > MAX_BULK_TAG_PEOPLE) {
    throw badRequest(`Bulk tag changes support up to ${MAX_BULK_TAG_PEOPLE} guests at a time.`);
  }

  const people = input.people.map((value) => {
    const person = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      personId: identifier(person.personId, "A person id is required for every selected guest."),
      eventId: identifier(person.eventId, "An event id is required for every selected guest."),
    };
  });
  const seenPeople = new Set<string>();
  for (const person of people) {
    if (seenPeople.has(person.personId)) throw badRequest("Each selected guest can appear only once.");
    seenPeople.add(person.personId);
  }

  if (people.length * tagIds.length > MAX_BULK_TAG_MUTATIONS) {
    throw badRequest(`Bulk tag changes support up to ${MAX_BULK_TAG_MUTATIONS} guest-tag updates at a time.`);
  }

  return { people, tagIds, removed: input.removed };
}

function identifier(value: unknown, message: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 200 || !/^[a-z0-9@._:-]+$/i.test(normalized)) throw badRequest(message);
  return normalized;
}

function badRequest(message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = 400;
  return error;
}
