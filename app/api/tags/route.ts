import { hasLumaDb, listIndexedPersonTags, setIndexedPersonTags } from "../luma/db";
import { requireSessionKey } from "../session-auth";

type HttpError = Error & { code?: string; status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    return Response.json({ tags: await listIndexedPersonTags() });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

export async function PATCH(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json() as { personId?: unknown; tags?: unknown };
    const rawPersonId = body.personId;
    const personId = typeof rawPersonId === "string" ? rawPersonId.trim() : "";
    if (!personId) return Response.json({ error: "A person id is required." }, { status: 400 });

    const person = await setIndexedPersonTags(personId, body.tags);
    return Response.json({ personId: person.personId, tags: person.tags });
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

function errorResponse(error: HttpError) {
  const status = error.code === "P2025" ? 404 : error.status || 500;
  const message = status === 500 ? "Unable to update guest tags." : error.message;
  return Response.json({ error: message }, { status });
}
