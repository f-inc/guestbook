import { hasLumaDb, updateIndexedPersonPhoneNumber } from "../../luma/db";
import { normalizePersonPhoneNumber } from "../../luma/person-phone";
import { requireSessionKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    requireSessionKey(request);
    if (!hasLumaDb()) throw httpError(503, "Phone updates require DB_URL to be configured.");

    const body = await request.json() as { personId?: unknown; phoneNumber?: unknown };
    const personId = typeof body.personId === "string" ? body.personId.trim() : "";
    if (!personId) throw httpError(400, "A person id is required.");

    const phoneNumber = normalizePersonPhoneNumber(body.phoneNumber);
    const result = await updateIndexedPersonPhoneNumber(personId, phoneNumber || null);
    if (!result.updatedCount) throw httpError(404, "No indexed registrations were found for this person.");

    clearEventGuestCaches();
    return Response.json({ personId, phoneNumber, updatedCount: result.updatedCount });
  } catch (error) {
    const http = error as HttpError;
    return Response.json(
      { error: http.status ? http.message : "Unable to update the phone number." },
      { status: http.status || 500 },
    );
  }
}

function httpError(status: number, message: string) {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

function clearEventGuestCaches() {
  const cache = (globalThis as typeof globalThis & { __guestbookLumaCache?: Map<string, unknown> }).__guestbookLumaCache;
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.startsWith("event-guests:")) cache.delete(key);
  }
}
