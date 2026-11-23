import { isRecipientMatching } from "../open-campus/recipients";
import { loadFunnelHistory } from "./history";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../luma/db";
import { apiError, authorize, fail, json } from "../../shared";
import { buildOpenCampusFunnel, type FunnelQuery } from "./cohort";

export async function openCampusFunnel(
  request: Request,
  db?: ReturnType<typeof prisma>,
  now = new Date(),
) {
  try {
    db ??= prisma();
    const key = await authorize(request, "events:read", db);
    if (!key.scopes.includes("guests:read")) fail("This API key requires guests:read.", 403);
    if (new URL(request.url).search) fail("Query parameters are not supported.");
    const text = await request.text();
    if (text.length > 2_000_000) fail("Funnel request limit exceeded.", 413);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(text);
    } catch {
      fail("Invalid funnel request.");
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (name) => !["from", "to", "category", "location", "status", "matching"].includes(name),
      )
    )
      fail("Invalid funnel request.");
    const validDay = (value: unknown): value is string =>
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value;
    if (
      !validDay(input.from) ||
      !validDay(input.to) ||
      Date.parse(input.to) <= Date.parse(input.from) ||
      Date.parse(input.to) - Date.parse(input.from) > 366 * 86400000
    )
      fail("Choose valid dates spanning up to one year; to is exclusive.");
    for (const field of ["category", "location"])
      if (
        input[field] !== undefined &&
        (typeof input[field] !== "string" || (input[field] as string).length > 2000)
      )
        fail("Invalid funnel filters.");
    if (
      input.status !== undefined &&
      !["held", "ongoing", "upcoming", "unknown"].includes(input.status as string)
    )
      fail("Invalid funnel status.");
    if (input.matching !== undefined && (!isRecipientMatching(input.matching, now) ||
        Buffer.byteLength(JSON.stringify(input.matching)) > 131072)) fail("Invalid recipient matching payload.");
    const matching = isRecipientMatching(input.matching, now) && (input.from as string) >= "2026-09-20"
      ? { ...input.matching, secret: request.headers.get("authorization")!.slice(7) } : undefined;
    const data = await db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const { events, guests } = await loadFunnelHistory(tx, key.eventIds);
        const complete = events.filter(
          (event) =>
            event.syncState?.lastGuestSyncAt &&
            ["success", "skipped_fresh"].includes(event.syncState.lastStatus || "") &&
            !event.syncState.truncated,
        );
        return {
          ...buildOpenCampusFunnel(events, guests, input as FunnelQuery, now, matching),
          historyScope: key.eventIds,
          coverage: {
            events: events.length,
            completeEvents: complete.length,
            historyComplete: complete.length === events.length,
            restrictedHistory: key.eventIds.length > 0,
            oldestSync:
              complete.map((event) => event.syncState!.lastGuestSyncAt!.toISOString()).sort()[0] ??
              null,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return json({ data, source: "guestbook-index", asOf: now.toISOString() });
  } catch (error) {
    return apiError(error);
  }
}
