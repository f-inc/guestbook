import { requireGuestbookKey } from "../../session-auth";
import { lumaConnectionStatus } from "../connection-status";
import { withBrowserLumaSession } from "../browser-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "cache-control": "private, no-store" };
  try {
    requireGuestbookKey(request);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: error.status || 500, headers });
  }
  return withBrowserLumaSession(request, async () => Response.json(await lumaConnectionStatus(), { headers }));
}
