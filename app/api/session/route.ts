import { requireSessionKey } from "../session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireSessionKey(request);
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error: any) {
    return Response.json(
      { ok: false, error: error.message || "Unable to validate the session key." },
      {
        status: error.status || 500,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
