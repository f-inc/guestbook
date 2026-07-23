import { hasLumaDb, listIndexedAudienceTagGroups, listIndexedPeopleByTag } from "../../luma/db";
import { requireSessionKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Audience tags require DB_URL." }, { status: 503 });
    const url = new URL(request.url);
    const tag = (url.searchParams.get("tag") || "").trim();
    const tagId = (url.searchParams.get("tag_id") || "").trim();
    const idsOnly = url.searchParams.get("ids_only") === "1";
    if (!tag && !tagId) return Response.json({ tags: await listIndexedAudienceTagGroups() });
    return Response.json(await listIndexedPeopleByTag(tag, { tagId, idsOnly }));
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json({ error: httpError.status ? httpError.message : "Unable to load tag audience." }, { status: httpError.status || 500 });
  }
}
