import { handoffHandler } from "../../../luma/database-handoff";
import { openCampusFunnel } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(request: Request) {
  return openCampusFunnel(request);
}

export const POST = handoffHandler(handlePOST);
