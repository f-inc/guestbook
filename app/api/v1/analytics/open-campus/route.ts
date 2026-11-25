import { handoffHandler } from "../../../luma/database-handoff";
import { openCampusAnalytics } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request) { return openCampusAnalytics(request); }

async function handlePOST(request: Request) { return openCampusAnalytics(request); }

export const GET = handoffHandler(handleGET);

export const POST = handoffHandler(handlePOST);
