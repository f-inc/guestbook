import { hasLumaDb, listIndexedEventCohortCounts, listIndexedPeopleByEventCohort } from "../../luma/db";
import { requireSessionKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Event audiences require DB_URL." }, { status: 503 });
    const url = new URL(request.url);
    if (url.searchParams.get("counts") === "1") return Response.json({ counts: await listIndexedEventCohortCounts() });
    const eventId = (url.searchParams.get("event_id") || "").trim();
    const requestedCohort = url.searchParams.get("cohort");
    const cohort = requestedCohort === "registered" || requestedCohort === "invited" ? requestedCohort : "attended";
    const idsOnly = url.searchParams.get("ids_only") === "1";
    if (!eventId) return Response.json({ error: "An event id is required." }, { status: 400 });
    return Response.json(await listIndexedPeopleByEventCohort(eventId, cohort, { idsOnly }));
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json({ error: httpError.status ? httpError.message : "Unable to load event audience." }, { status: httpError.status || 500 });
  }
}
