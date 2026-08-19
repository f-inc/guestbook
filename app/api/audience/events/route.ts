import { getIndexedEventAnalytics, hasLumaDb, listIndexedEventCohortCounts, listIndexedPeopleByEventCohort } from "../../luma/db";
import { requireGuestbookKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Event audiences require DB_URL." }, { status: 503 });
    const url = new URL(request.url);
    if (url.searchParams.get("counts") === "1") return Response.json({ counts: await listIndexedEventCohortCounts() });
    const eventId = (url.searchParams.get("event_id") || "").trim();
    if (url.searchParams.get("questions") === "1") {
      if (!eventId) return Response.json({ error: "An event id is required." }, { status: 400 });
      const analytics = await getIndexedEventAnalytics(eventId);
      if (!analytics) return Response.json({ error: "Event not found." }, { status: 404 });
      return Response.json({
        questions: (analytics.analyticsAllQuestions || [])
          .filter((question) => question.kind !== "text" && question.options.length)
          .map((question) => ({
            id: question.id,
            label: question.label,
            responseCount: question.responseCount,
            kind: question.kind,
            options: question.options.map((option) => ({
              label: option.label,
              answerKey: option.answerKey,
              count: option.count,
              checkedInCount: option.checkedInCount,
            })),
          })),
      });
    }
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
