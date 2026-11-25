import { handoffHandler } from "../../../../luma/database-handoff";
import { personEvents } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request, context: { params: Promise<{ personId: string }> }) {
  return personEvents(request, (await context.params).personId);
}

export const GET = handoffHandler(handleGET);
