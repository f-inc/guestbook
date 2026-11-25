import { handoffHandler } from "../luma/database-handoff";
import { hasLumaDb, listIndexedSuperTags, syncIndexedSuperTags } from "../luma/db";
import { requireGuestbookKey } from "../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

async function handleGET(request: Request) {
  try {
    requireGuestbookKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Supertags require DB_URL." }, { status: 503 });
    return Response.json({ superTags: await listIndexedSuperTags() });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

async function handlePUT(request: Request) {
  try {
    requireGuestbookKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Supertags require DB_URL." }, { status: 503 });
    const body = await request.json() as { superTags?: unknown };
    return Response.json({ superTags: await syncIndexedSuperTags(body.superTags) });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

function errorResponse(error: HttpError) {
  const status = error.status || 500;
  return Response.json(
    { error: status === 500 ? "Unable to update supertags." : error.message },
    { status },
  );
}

export const GET = handoffHandler(handleGET);

export const PUT = handoffHandler(handlePUT);
