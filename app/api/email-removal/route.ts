import { after } from "next/server";
import { requireGuestbookKey } from "../session-auth";
import { removalCanPreview, removalCanConfirm } from "../luma/email-removal-policy";
import { confirmRemoval, previewRemoval, removalCalendars, removalStatus, requireRemovalEnabled, retryFailedRemoval, runRemovalBatch } from "../luma/email-removal";
export const runtime = "nodejs";
const failure = (e: any) => Response.json({ error: e.publicMessage ? e.message : e.status === 401 ? "Please unlock Guestbook." : "Unable to process removals. Saved progress is retained." }, { status: e.status || 500 });
export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    if (!removalCanPreview()) return Response.json({ configured: false, canConfirm:false });
    const p = new URL(request.url).searchParams;
    if (p.get("calendars") === "1") return Response.json({ calendars: (await removalCalendars()).map(({id,name}) => ({id,name})) });
    return Response.json({ configured: true, canConfirm:removalCanConfirm(), ...await removalStatus(p.get("job") || undefined, Math.max(0, Math.min(50000, Math.floor(Number(p.get("offset")) || 0)))) });
  } catch(e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    requireGuestbookKey(request); requireRemovalEnabled();
    const input = await request.json() as any;
    if (input.action === "preview") return Response.json(await previewRemoval(input));
    if (input.action === "confirm") await confirmRemoval(String(input.jobId || ""), input.confirmation);
    else if (input.action === "retry") await retryFailedRemoval(String(input.jobId || ""));
    else return Response.json({error:"Unknown action."}, {status:400});
    after(async () => { await runRemovalBatch().catch(() => {}); });
    return Response.json({ok:true});
  } catch(e) { return failure(e); }
}
