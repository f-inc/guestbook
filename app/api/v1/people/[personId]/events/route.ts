import { personEvents } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ personId: string }> }) {
  return personEvents(request, (await context.params).personId);
}
