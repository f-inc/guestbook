import { requireGuestbookKey } from "../../session-auth";
import { requireCioWorker } from "../auth";
import { cioRuntimeMode, normalizeCioEmail } from "../../luma/cio-projection";
import { cioSyncHealth, loadCioProjection, seedCioQueue, privateCioReference } from "../../luma/cio-sync";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    const mode = cioRuntimeMode();
    return Response.json({ mode, ...(mode === "disabled" ? {} : await cioSyncHealth()) }, { headers: { "cache-control": "no-store" } });
  } catch (error: any) { return Response.json({ error: "Unable to read sync health" }, { status: error.status || 503 }); }
}
export async function POST(request: Request) {
  try {
    requireGuestbookKey(request);
    const body = await request.json() as { action?: string; email?: string };
    if (body.action === "preview") {
      const email = normalizeCioEmail(body.email);
      if (!email) return Response.json({ error: "A valid email is required" }, { status: 400 });
      const projection = await loadCioProjection(email);
      return Response.json({ mode: "preview", reference: privateCioReference(email), ...projection }, { headers: { "cache-control": "no-store" } });
    }
    if (body.action === "seed") {
      requireCioWorker(request);
      if (process.env.CIO_SYNC_ENABLED !== "true" || process.env.CIO_SYNC_BACKFILL_ENABLED !== "true") return Response.json({ error: "Backfill is disabled" }, { status: 409 });
      return Response.json(await seedCioQueue());
    }
    return Response.json({ error: "Use preview or seed" }, { status: 400 });
  } catch (error: any) { return Response.json({ error: "Sync request failed" }, { status: error.status || 503 }); }
}
