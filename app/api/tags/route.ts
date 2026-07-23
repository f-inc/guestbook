import { createIndexedTagDefinition, hasLumaDb, listIndexedEventGuestMutationTargets, listIndexedTagDefinitions, mutateIndexedPeopleTags, mutateIndexedPersonTag, updateIndexedTagDefinition } from "../luma/db";
import { requireSessionKey } from "../session-auth";
import { MAX_ALL_MATCHING_TAG_MUTATIONS, MAX_ALL_MATCHING_TAG_PEOPLE, parseBulkManualTagMutation, parseManualTagMutation } from "./manual-tag-mutation";

type HttpError = Error & { code?: string; status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    return Response.json({ tags: await listIndexedTagDefinitions() });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

export async function POST(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json() as { name?: unknown; color?: unknown };
    const tag = await createIndexedTagDefinition(body);
    clearEventGuestCaches();
    return Response.json({ tag }, { status: 201 });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

export async function PUT(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json() as { id?: unknown; name?: unknown; color?: unknown };
    const tag = await updateIndexedTagDefinition(body.id, body);
    clearEventGuestCaches();
    return Response.json({ tag });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

export async function PATCH(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json() as Record<string, unknown>;
    if (body.bulk === true) {
      const mutation = parseBulkManualTagMutation(body);
      let targetPeople: Array<{ personId: string; eventId: string }>;
      if (!("people" in mutation)) {
        const peopleById = new Map<string, { personId: string; eventId: string }>();
        for (const eventId of mutation.eventIds) {
          const targets = await listIndexedEventGuestMutationTargets(eventId, mutation.query, {
            limit: MAX_ALL_MATCHING_TAG_PEOPLE + 1,
          });
          for (const target of targets) {
            if (!peopleById.has(target.personId)) peopleById.set(target.personId, { personId: target.personId, eventId });
          }
          if (peopleById.size > MAX_ALL_MATCHING_TAG_PEOPLE) break;
        }
        targetPeople = [...peopleById.values()];
        if (!targetPeople.length) throw badRequest("No guests match the selected filters.");
        if (targetPeople.length > MAX_ALL_MATCHING_TAG_PEOPLE) {
          throw badRequest(`All-matching tag changes support up to ${MAX_ALL_MATCHING_TAG_PEOPLE} guests at a time.`);
        }
        if (targetPeople.length * mutation.tagIds.length > MAX_ALL_MATCHING_TAG_MUTATIONS) {
          throw badRequest(`All-matching tag changes support up to ${MAX_ALL_MATCHING_TAG_MUTATIONS} guest-tag updates at a time.`);
        }
      } else {
        targetPeople = mutation.people;
      }
      const people = await mutateIndexedPeopleTags({
        people: targetPeople,
        tagIds: mutation.tagIds,
        removed: mutation.removed,
      });
      clearEventGuestCaches();
      return Response.json({
        tagIds: mutation.tagIds,
        removed: mutation.removed,
        allMatching: "allMatching" in mutation && mutation.allMatching,
        matchedPeople: targetPeople.length,
        people,
      });
    }
    const mutation = parseManualTagMutation(body);
    const person = await mutateIndexedPersonTag(mutation);
    clearEventGuestCaches();
    return Response.json({
      personId: person.personId,
      tagId: mutation.tagId,
      eventId: mutation.eventId,
      removed: mutation.removed,
      tags: person.tags,
      manualTags: person.manualTags,
      automaticTags: person.automaticTags,
    });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

function requireDatabase() {
  if (!hasLumaDb()) {
    const error = new Error("Guest tags require DB_URL to be configured.") as HttpError;
    error.status = 503;
    throw error;
  }
}

function badRequest(message: string) {
  const error = new Error(message) as HttpError;
  error.status = 400;
  return error;
}

function clearEventGuestCaches() {
  const cache = (globalThis as typeof globalThis & { __guestbookLumaCache?: Map<string, unknown> }).__guestbookLumaCache;
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.startsWith("event-guests:")) cache.delete(key);
  }
}

function errorResponse(error: HttpError) {
  const status = error.code === "P2025" ? 404 : error.status || 500;
  const message = status === 500 ? "Unable to update guest tags." : error.message;
  return Response.json({ error: message }, { status });
}
