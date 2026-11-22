import { openCampusFunnel } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return openCampusFunnel(request);
}
