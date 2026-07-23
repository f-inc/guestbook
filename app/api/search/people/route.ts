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
    const { query, limit, scope } = parsePeopleSearchQuery(new URL(request.url).searchParams);
    if (!query) return Response.json({ people: [] });
    return Response.json(await (scope === "name" ? searchIndexedPeopleByName(query, { limit }) : searchIndexedPeople(query, { limit })));
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json(
      { error: httpError.status ? httpError.message : "Unable to search people." },
      { status: httpError.status || 500 },
    );
  }
}
