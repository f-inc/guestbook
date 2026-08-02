import { countIndexedAudience, hasLumaDb, listIndexedAudiencePage, normalizeIndexedAudienceCriteria } from "../../luma/db";
import { requireSessionKey } from "../../session-auth";

type HttpError = Error & { status?: number };

export const runtime = "nodejs";

export async function POST(request: Request) {
  const startedAt = performance.now();
  try {
    requireSessionKey(request);
    if (!hasLumaDb()) return Response.json({ error: "Audience resolution requires DB_URL." }, { status: 503 });
    const body = await request.json() as Record<string, unknown>;
    const criteria = normalizeIndexedAudienceCriteria(body?.criteria);
    if (body?.countsOnly === true) {
      const data = await countIndexedAudience(criteria);
      return Response.json(data, {
        headers: { "server-timing": `audience-count;dur=${(performance.now() - startedAt).toFixed(1)}` },
      });
    }
    const cursor = typeof body?.cursor === "string" ? body.cursor : Number(body?.cursor) || 0;
    const pageSize = Number(body?.pageSize) || 100;
    const includeTotals = body?.includeTotals !== false;
    const query = typeof body?.query === "string" ? body.query.trim().slice(0, 120) : "";
    const data = await listIndexedAudiencePage(criteria, { cursor, pageSize, includeTotals, query });
    return Response.json(data, {
      headers: { "server-timing": `audience-page;dur=${(performance.now() - startedAt).toFixed(1)}` },
    });
  } catch (error) {
    const httpError = error as HttpError;
    return Response.json({ error: httpError.status ? httpError.message : "Unable to resolve the selected audience." }, { status: httpError.status || 500 });
  }
}
