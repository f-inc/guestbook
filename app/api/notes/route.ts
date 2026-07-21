import { hasLumaDb, updateIndexedPersonCrmNotes } from "../luma/db";
import { requireSessionKey } from "../session-auth";
import { normalizeGuestNote } from "./guest-notes";

type HttpError = Error & { code?: string; status?: number };

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json() as { personId?: unknown; notes?: unknown };
    const personId = typeof body.personId === "string" ? body.personId.trim() : "";
    if (!personId) return Response.json({ error: "A person id is required." }, { status: 400 });

    const person = await updateIndexedPersonCrmNotes(personId, normalizeGuestNote(body.notes));
    clearEventGuestCaches();
    return Response.json({
      personId: person.personId,
      notes: person.crmNotes,
      updatedAt: person.crmNotesUpdatedAt?.toISOString() || null,
    });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

function requireDatabase() {
  if (hasLumaDb()) return;
  const error = new Error("Guest notes require DB_URL to be configured.") as HttpError;
  error.status = 503;
  throw error;
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
  const message = status === 500 ? "Unable to save guest notes." : error.message;
  return Response.json({ error: message }, { status });
}
