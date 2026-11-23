import { openCampusAnalytics } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return openCampusAnalytics(request); }

export async function POST(request: Request) { return openCampusAnalytics(request); }
