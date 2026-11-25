import { handoffHandler } from "../../../../luma/database-handoff";
import { guests } from "./handler";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
async function handleGET(request: Request, context: { params: Promise<{ eventId: string }> }) {
  return guests(request, (await context.params).eventId);
}

export const GET = handoffHandler(handleGET);
