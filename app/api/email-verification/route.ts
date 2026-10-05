import { prisma } from "../luma/db";
import { verificationAudience } from "../luma/email-verification";
import { emailableCredits } from "../luma/emailable-client";
import { after } from "next/server";
import { requireGuestbookKey } from "../session-auth";
import { resumeVerification, runVerificationTick, startVerification, verificationOverview } from "../luma/email-verification";
export const runtime = "nodejs";
function failure(error: any) {
  return Response.json({ error: error.publicMessage ? error.message : error.status === 401 ? "Please unlock Guestbook." : "Unable to load or start email verification. Check server configuration and try again." }, { status: error.status || 500 });
}
export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    const params = new URL(request.url).searchParams;
    if (params.get("credits") === "1") {
      try { return Response.json({ available: await emailableCredits(), checkedAt: new Date().toISOString() }); }
      catch { return Response.json({ available: null, error: "Unable to check Emailable credits. Refresh to try again." }, { status: 503 }); }
    }
    if (params.has("email")) return Response.json({ checks: await prisma().emailVerificationCheck.findMany({ where: { emailLower: (params.get("email") || "").trim().toLowerCase() }, orderBy: [{ checkedAt: "desc" }, { id: "desc" }], take: 21, ...(params.get("cursor") ? { cursor: { id: params.get("cursor")! }, skip: 1 } : {}) }) });
    const offset = Math.max(0, Math.min(10000000, Math.floor(Number(params.get("offset")) || 0)));
    return Response.json(await verificationOverview((params.get("q") || "").slice(0, 120), params.get("filter") || "issues", offset));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    requireGuestbookKey(request);
    const { action, maxEmails, criteria, eventIds: requestedEvents } = await request.json() as any;
    let scope: Awaited<ReturnType<typeof verificationAudience>> | undefined;
    if ((action === "preview" || action === "start") && criteria != null) {
      const eventIds = [...new Set<string>((Array.isArray(requestedEvents) ? requestedEvents : []).filter(e => typeof e === "string" && e.startsWith("evt-")))].slice(0, 100);
      if (!eventIds.length) return Response.json({ error: "Select an event for this audience." }, { status: 400 });
      scope = await verificationAudience(criteria, eventIds);
    }
    if (action === "preview") {
      if (!scope) return Response.json({ error: "Select an audience." }, { status: 400 });
      const { emails, ...summary } = scope;
      after(async () => { await runVerificationTick().catch(() => {}); });
      return Response.json({ ...summary, credits: await emailableCredits() });
    }
    if (action === "start") {
      if (!Number.isSafeInteger(maxEmails) || maxEmails! < 1) return Response.json({ error: "Refresh the credit balance before starting a scan." }, { status: 400 });
      await startVerification(maxEmails, undefined, undefined, scope);
    }
    else if (action === "resume") await resumeVerification();
    else if (action !== "advance") return Response.json({ error: "Unknown action." }, { status: 400 });
    after(async () => { await runVerificationTick().catch(() => {}); });
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}
