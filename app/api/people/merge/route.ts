import { handoffHandler } from "../../luma/database-handoff";
import type { MergeSignal } from "../../luma/merge-matching";
import { invalidateIndexedAudienceCaches } from "../../luma/db";
import { requireGuestbookKey } from "../../session-auth";
import { mergeError, mergePeople, preview, station, undoMerge } from "./store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function identifier(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 320) throw mergeError("A valid profile or merge ID is required.");
  return value.trim();
}
function failure(error: unknown) {
  const status = (error as { status?: number })?.status || 500;
  return Response.json({ error: status === 500 ? "Unable to load or update person merges." : (error as Error).message }, { status });
}
async function handleGET(request: Request) {
  try {
    requireGuestbookKey(request);
    const ids = new URL(request.url).searchParams.getAll("personId");
    if (ids.length > 2) throw mergeError("Preview at most two profiles at a time.");
    const signals = new URL(request.url).searchParams.getAll("signal");
    if (signals.some(s => !["name", "social", "phone"].includes(s))) throw mergeError("Choose a name, social, or phone filter.");
    return Response.json(ids.length ? await preview(ids.map(identifier)) : await station(undefined, signals.length ? signals as MergeSignal[] : undefined), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
async function handlePOST(request: Request) {
  try {
    requireGuestbookKey(request);
    const body = await request.json() as Record<string, unknown>;
    if (!Array.isArray(body.reviewedPersonIds) || body.reviewedPersonIds.length > 100) throw mergeError("Review the profiles before merging.");
    const reviewed = body.reviewedPersonIds.map(identifier);
    if (body.operationId !== undefined && (typeof body.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId))) throw mergeError("A valid operation ID is required.");
    const result = await mergePeople(identifier(body.left), identifier(body.right), identifier(body.primary), undefined, reviewed, body.operationId as string | undefined);
    clearCaches();
    return Response.json(result);
  } catch (error) { return failure(error); }
}
async function handleDELETE(request: Request) {
  try {
    requireGuestbookKey(request);
    const body = await request.json() as Record<string, unknown>;
    const result = await undoMerge(identifier(body.id));
    clearCaches();
    return Response.json(result);
  } catch (error) { return failure(error); }
}

function clearCaches() {
  invalidateIndexedAudienceCaches();
  const cache = (globalThis as typeof globalThis & { __guestbookLumaCache?: Map<string, unknown> }).__guestbookLumaCache;
  cache?.clear();
}

export const GET = handoffHandler(handleGET);

export const POST = handoffHandler(handlePOST);

export const DELETE = handoffHandler(handleDELETE);
