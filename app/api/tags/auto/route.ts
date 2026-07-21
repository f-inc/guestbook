import { getAutomaticTagStatus, hasLumaDb, runAutomaticTagClassifier } from "../../luma/db";
import { requireSessionKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    return Response.json({ ok: true, status: await getAutomaticTagStatus() });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

export async function POST(request: Request) {
  try {
    requireSessionKey(request);
    requireDatabase();
    const body = await request.json().catch(() => ({})) as {
      scope?: unknown;
      dryRun?: unknown;
      personIds?: unknown;
    };
    const scope = body.scope === "changed" ? "changed" : "all";
    const result = await runAutomaticTagClassifier({
      forceFull: scope === "all",
      personIds: scope === "changed" ? body.personIds : undefined,
      dryRun: body.dryRun === true,
    });
    if (!result.dryRun && result.changedCount) clearEventGuestCaches();
    return Response.json(result, { status: result.status === "already_running" ? 202 : 200 });
  } catch (error) {
    return errorResponse(error as HttpError);
  }
}

function requireDatabase() {
  if (!hasLumaDb()) {
    const error = new Error("Automatic tags require DB_URL to be configured.") as HttpError;
    error.status = 503;
    throw error;
  }
}

function clearEventGuestCaches() {
  const cache = (globalThis as typeof globalThis & { __guestbookLumaCache?: Map<string, unknown> }).__guestbookLumaCache;
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.startsWith("event-guests:") || key.startsWith("trace-person:")) cache.delete(key);
  }
}

function errorResponse(error: HttpError) {
  return Response.json({ ok: false, error: error.message || "Unable to update automatic tags." }, { status: error.status || 500 });
}
