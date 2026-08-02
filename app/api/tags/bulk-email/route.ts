import { hasLumaDb, matchIndexedPeopleByEmails, mutateIndexedPeopleTags } from "../../luma/db";
import { requireSessionKey } from "../../session-auth";
import { parseBulkEmails } from "../bulk-email-tags";

type HttpError = Error & { code?: string; status?: number };

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json() as Record<string, unknown>;
    const action = body.action === "apply" ? "apply" : "preview";
    const parsed = parseBulkEmails(body.emails);
    const matchedPeople = await matchIndexedPeopleByEmails(parsed.emails);
    const matchedEmailSet = new Set(matchedPeople.map((person) => person.emailLower).filter(Boolean));
    const unmatchedEmails = [
      ...parsed.emails.filter((email) => !matchedEmailSet.has(email)),
      ...parsed.invalidEmails,
    ];

    if (action === "preview") {
      return Response.json({
        inputCount: parsed.emails.length + parsed.invalidEmails.length,
        matchedEmailCount: matchedEmailSet.size,
        matchedPeopleCount: matchedPeople.length,
        unmatchedEmails,
        invalidEmails: parsed.invalidEmails,
        people: matchedPeople.map(personSummary),
      });
    }

    const tagId = identifier(body.tagId, "Select a tag to apply.");
    if (!matchedPeople.length) throw badRequest("None of the pasted emails match people in the database.");
    const updatedPeople = [];
    for (let index = 0; index < matchedPeople.length; index += 500) {
      updatedPeople.push(...await mutateIndexedPeopleTags({
        people: matchedPeople.slice(index, index + 500).map((person) => ({ personId: person.personId, eventId: null })),
        tagIds: [tagId],
        removed: false,
      }));
    }
    clearEventGuestCaches();
    return Response.json({
      inputCount: parsed.emails.length + parsed.invalidEmails.length,
      matchedEmailCount: matchedEmailSet.size,
      matchedPeopleCount: matchedPeople.length,
      taggedPeopleCount: updatedPeople.length,
      unmatchedEmails,
      invalidEmails: parsed.invalidEmails,
      people: updatedPeople,
    });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

function personSummary(person: { personId: string; name: string; email: string | null; tags: unknown }) {
  return { personId: person.personId, name: person.name, email: person.email || "", tags: person.tags };
}

function identifier(value: unknown, message: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 200 || !/^[a-z0-9@._:-]+$/i.test(normalized)) throw badRequest(message);
  return normalized;
}

function requireDatabase() {
  if (!hasLumaDb()) {
    const error = new Error("Bulk email tagging requires DB_URL to be configured.") as HttpError;
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
  return Response.json({ error: status === 500 ? "Unable to bulk tag emails." : error.message }, { status });
}
