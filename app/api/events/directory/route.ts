import { handoffHandler } from "../../luma/database-handoff";
import { hasLumaDb, listIndexedEventDirectory } from "../../luma/db";
import { requireGuestbookKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

async function handleGET(request: Request) {
  try {
    requireGuestbookKey(request);
    if (!hasLumaDb()) {
      return Response.json({ error: "The event directory requires DB_URL." }, { status: 503 });
    }
    return Response.json(await listIndexedEventDirectory());
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json(
      { error: httpError.status ? httpError.message : "Unable to load the event directory." },
      { status: httpError.status || 500 },
    );
  }
}

export const GET = handoffHandler(handleGET);
