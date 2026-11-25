import { handoffHandler } from "../../luma/database-handoff";
import { events } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) { return events(request); }

export const GET = handoffHandler(handleGET);
