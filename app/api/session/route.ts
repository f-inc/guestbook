import { sourcePrisma } from "../luma/db";
import { handoffHandler, verifyDatabaseHandoffDestination } from "../luma/database-handoff";
import { humanIdentityEnabled } from "../luma/human-mode";
import { requireGuestbookKey } from "../session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(request: Request) {
  try {
    requireGuestbookKey(request);
    if (new URL(request.url).searchParams.get("handoff") === "verify")
      return Response.json(await verifyDatabaseHandoffDestination(), { headers: { "cache-control": "private, no-store" } });
    const [identity] = await sourcePrisma().$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
    return Response.json(
      { databaseSchema: identity.schema, ok: true, identityMode: humanIdentityEnabled() ? "human" : "legacy" },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error: any) {
    return Response.json(
      { ok: false, error: error.message || "Unable to validate the Guestbook key." },
      {
        status: error.status || 500,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}

export const GET = handoffHandler(handleGET);
