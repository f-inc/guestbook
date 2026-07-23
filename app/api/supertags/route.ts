import { hasLumaDb, listIndexedSuperTags, syncIndexedSuperTags } from "../luma/db";
import { requireSessionKey } from "../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Supertags require DB_URL." }, { status: 503 });
    return Response.json({ superTags: await listIndexedSuperTags() });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

export async function PUT(request: Request) {
  try {
    requireSessionKey(request);
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
