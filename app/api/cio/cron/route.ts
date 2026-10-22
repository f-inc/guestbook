import { requireCioWorker } from "../auth";
import { runCioScheduledSync } from "../../luma/cio-scheduler";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    requireCioWorker(request);
    const result = await runCioScheduledSync();
    return Response.json(result, { status: result.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch (error: any) { return Response.json({ error: "Sync worker failed; inspect health and configuration" }, { status: error.status || 503 }); }
}
