import { hasLumaDb, searchIndexedPeople, searchIndexedPeopleByName } from "../../luma/db";
import { requireSessionKey } from "../../session-auth";
import { parsePeopleSearchQuery } from "./query";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    if (!hasLumaDb()) {
      return Response.json({ error: "People search requires DB_URL to be configured." }, { status: 503 });
    }
    const {
      query,
      limit,
      offset,
      scope,
      includedTags,
      excludedTags,
      tagMode,
      comments,
      hasFilters,
    } = parsePeopleSearchQuery(new URL(request.url).searchParams);
    if (!query && (scope === "name" || !hasFilters)) {
      return Response.json({ people: [], hasMore: false, nextOffset: 0 });
    }
    return Response.json(await (scope === "name"
      ? searchIndexedPeopleByName(query, { limit, offset })
      : searchIndexedPeople(query, {
          limit,
          offset,
          includedTags,
          excludedTags,
          tagMode,
          comments,
        })));
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json(
      { error: httpError.status ? httpError.message : "Unable to search people." },
      { status: httpError.status || 500 },
    );
  }
}
