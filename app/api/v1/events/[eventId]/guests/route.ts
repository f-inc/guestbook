import { guests } from "./handler";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ eventId: string }> }) {
  return guests(request, (await context.params).eventId);
}
