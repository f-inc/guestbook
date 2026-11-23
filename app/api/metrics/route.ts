import { metricPeople } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => metricPeople(request);
