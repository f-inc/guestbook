import { hasLumaDb, listIndexedAudienceSuperTagGroups, listIndexedAudienceTagGroups, listIndexedEventCohortCounts } from "../../luma/db";
import { requireGuestbookKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Invite metadata requires DB_URL." }, { status: 503 });
    const include = new URL(request.url).searchParams.get("include") || "all";
    if (!new Set(["tags", "events", "all"]).has(include)) {
      return Response.json({ error: "Include must be tags, events, or all." }, { status: 400 });
    }

    const [tags, superTags, counts] = await Promise.all([
      include === "tags" || include === "all" ? listIndexedAudienceTagGroups() : Promise.resolve(undefined),
      include === "tags" || include === "all" ? listIndexedAudienceSuperTagGroups() : Promise.resolve(undefined),
      include === "events" || include === "all" ? listIndexedEventCohortCounts() : Promise.resolve(undefined),
    ]);
    return Response.json({
      ...(tags ? { tags } : {}),
      ...(superTags ? { superTags } : {}),
      ...(counts ? { counts } : {}),
    });
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json({ error: httpError.status ? httpError.message : "Unable to load invite metadata." }, { status: httpError.status || 500 });
  }
}
