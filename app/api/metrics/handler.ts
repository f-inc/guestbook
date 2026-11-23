import { requireGuestbookKey } from "../session-auth";
import { parseDrilldown, readMetricPeople, stageLabels } from "../../metrics/read";

/** Read-only workspace API; authorization precedes validation and every database read. */
export async function metricPeople(request: Request, read = readMetricPeople) {
  const headers = { "cache-control": "private, no-store" };
  try {
    requireGuestbookKey(request);
  } catch (error) {
    return Response.json(
      { error: "Guestbook authorization required." },
      {
        status: (error as Error & { status?: number }).status || 503,
        headers,
      },
    );
  }
  let input: ReturnType<typeof parseDrilldown>;
  try {
    input = parseDrilldown(new URL(request.url).searchParams);
  } catch {
    return Response.json({ error: "Invalid metric link." }, { status: 400, headers });
  }
  try {
    const data = await read(input);
    return Response.json(
      {
        data,
        stageLabel: stageLabels[input.stage],
        repeats: ["registrations", "accepted", "checkedIn"].includes(input.stage),
        from: input.query.from,
        to: input.query.to,
        page: input.page,
        expected: input.expected,
      },
      { headers },
    );
  } catch {
    return Response.json({ error: "Could not read this metric list." }, { status: 503, headers });
  }
}
