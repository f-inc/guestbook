import { handoffHandler } from "../../../luma/database-handoff";
import { eventAnalytics } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) { return eventAnalytics(request); }

export const GET = handoffHandler(handleGET);
