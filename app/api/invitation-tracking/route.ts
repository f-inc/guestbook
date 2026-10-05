import { lumaIssueResult, recordLumaIssue } from "../luma/email-policy";
import { groupedEmailIssues } from "../luma/email-issues";
import { requestBulkRefresh } from "../luma/tracking-bulk";
import {
  saveTrackingSession,
  serverTrackingSession,
} from "../luma/tracking-session";
import { enqueueDetails, runTrackingBatch } from "../luma/tracking-queue";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { prisma } from "../luma/db";
import { requireGuestbookKey } from "../session-auth";
import { createLumaClient } from "../luma/luma-client";
export const runtime = "nodejs";
const client = createLumaClient({
  logger: async (requestId, event, details) =>
    audit(requestId, { event, ...details }),
  fetchImpl: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(12000) }),
});

async function audit(requestId: string, details: object) {
  await mkdir(".debug", { recursive: true });
  await appendFile(
    ".debug/luma-api.log",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      event: "invitation tracking",
      details,
    }) + "\n",
  );
}
function ids(values: unknown) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .filter((x) => typeof x === "string" && x.startsWith("evt-"))
        .slice(0, 100),
    ),
  ] as string[];
}
function failure(error: any, requestId: string) {
  return Response.json(
    {
      error:
        error.code === "LUMA_SESSION_INVALID"
          ? "Tracking disconnected. Reconnect Luma to refresh. Cached results are still available."
          : error.status === 401
            ? "Please unlock Guestbook."
            : "Unable to update invitation tracking. Try again.",
      code: error.code,
      requestId,
    },
    { status: error.status || 500 },
  );
}
export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    requireGuestbookKey(request);
    const url = new URL(request.url),
      eventIds = ids(url.searchParams.getAll("event"));
    const issues = url.searchParams.get("issues") === "1";
    if (issues) {
      const q = (url.searchParams.get("q") || "").slice(0, 120);
      const offset = Math.max(
        0,
        Math.min(10000, Number(url.searchParams.get("offset")) || 0),
      );
      const result = await groupedEmailIssues(prisma(), q, offset);
      const optOuts = await prisma().lumaCalendarOptOut.findMany({
        where: q ? { emailLower: { contains: q.toLowerCase() } } : {},
        take: 51,
        skip: Math.max(
          0,
          Math.min(10000, Number(url.searchParams.get("optOutOffset")) || 0),
        ),
        orderBy: [{ observedAt: "desc" }, { emailLower: "asc" }],
      });
      return Response.json({
        ...result,
        optOuts: optOuts.slice(0, 50),
        optOutHasMore: optOuts.length > 50,
        requestId,
      });
    }

    if (!issues && !eventIds.length)
      return Response.json({ rows: [], counts: [], tracked: 0, total: 0 });
    const skip = Math.max(
      0,
      Math.min(10000, Number(url.searchParams.get("offset")) || 0),
    );
    const where: any = issues
      ? { issueReason: { not: null } }
      : { eventId: { in: eventIds } };
    const q = (url.searchParams.get("q") || "").slice(0, 120);
    if (q)
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { emailLower: { contains: q.toLowerCase() } },
      ];
    const [
      rows,
      counts,
      total,
      tracked,
      checked,
      queued,
      backfills,
      optOuts,
      unchecked,
    ] = await Promise.all([
      prisma().lumaInviteTracking.findMany({
        where:
          !issues && url.searchParams.has("person")
            ? {
                ...where,
                personId: {
                  in: url.searchParams.getAll("person").slice(0, 50),
                },
              }
            : where,
        orderBy: [
          { requestedAt: { sort: "desc", nulls: "last" } },
          { updatedAt: "desc" },
          { emailLower: "asc" },
        ],
        take: issues ? 50 : 500,
        skip,
      }),
      prisma().lumaInviteTracking.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      prisma().lumaEventGuest.count({
        where: {
          eventId: { in: eventIds },
          OR: [{ invitedAt: { not: null } }, { status: "invited" }],
        },
      }),
      prisma().lumaInviteTracking.count({ where }),
      prisma().lumaInviteTracking.count({
        where: {
          AND: [
            where,
            {
              OR: [
                { checkedAt: { not: null } },
                { bulkCheckedAt: { not: null } },
              ],
            },
          ],
        },
      }),
      prisma().lumaInviteTracking.count({
        where: {
          ...where,
          nextCheckAt: { lte: new Date() },
          priority: { gte: 20 },
        },
      }),
      prisma().lumaTrackingState.findMany({
        where: { key: { in: eventIds.map((id) => `bulk:${id}`) } },
        select: { active: true, owner: true, leaseUntil: true },
      }),
      issues
        ? prisma().lumaCalendarOptOut.findMany({
            where: q ? { emailLower: { contains: q.toLowerCase() } } : {},
            take: 51,
            skip: Math.max(
              0,
              Math.min(
                10000,
                Number(url.searchParams.get("optOutOffset")) || 0,
              ),
            ),
            orderBy: [{ observedAt: "desc" }, { emailLower: "asc" }],
          })
        : Promise.resolve([]),
      prisma().lumaInviteTracking.count({
        where: {
          ...where,
          status: "unknown",
          checkedAt: null,
          bulkCheckedAt: null,
        },
      }),
    ]);
    return Response.json({
      rows,
      optOuts: optOuts.slice(0, 50),
      optOutHasMore: optOuts.length > 50,
      counts: [
        ...counts.map((c) => ({
          status: c.status,
          count: c._count._all - (c.status === "unknown" ? unchecked : 0),
        })),
        { status: "not_loaded", count: unchecked },
      ],
      total,
      tracked,
      checked,
      queued,
      bulkRefreshActive: backfills.some((job) => job.active),
      refreshWarning: backfills.some((job) => job.owner)
        ? "Invitation refresh paused after a Luma error; cached results remain visible. We will retry shortly."
        : null,
      backgroundConfigured: process.env.LUMA_TRACKING_WORKER_ENABLED === "true",
      hasMore: skip + rows.length < tracked,
      requestId,
    });
  } catch (error: any) {
    await audit(requestId, {
      action: "read error",
      type: error.name,
      code: error.code || "TRACKING_ERROR",
    });
    return failure(error, requestId);
  }
}
export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    requireGuestbookKey(request);
    const body: any = await request.json();
    if (body.action === "check-email") {
      const emailLower = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!emailLower || emailLower.length > 320 || !emailLower.includes("@")) return Response.json({ error: "Select an email address." }, { status: 400 });
      const token = body.lumaSessionToken || await serverTrackingSession();
      if (typeof token !== "string" || !token || token.length > 8192 || /[\r\n]/.test(token)) return Response.json({ error: "Reconnect Luma to check this address. Cached results remain visible." }, { status: 403 });
      const startedAt = new Date();
      const result = lumaIssueResult(await client.privateGet({ requestId, lumaSessionToken: token, path: "/email/has-issue", params: { email: emailLower }, operation: "email restriction check" }));
      if (result === null) return Response.json({ error: "Luma returned an unrecognized result. The existing restriction has been preserved." }, { status: 502 });
      if (result) await recordLumaIssue(emailLower, "restricted", new Date());
      else await prisma().emailAddress.updateMany({ where: { emailLower, OR: [{ lumaBlockedAt: null }, { lumaBlockedAt: { lte: startedAt } }] }, data: { lumaBlockedReason: null, lumaClearedAt: startedAt, lumaCheckedAt: startedAt } });
      await prisma().emailAddress.updateMany({ where: { emailLower }, data: { lumaCheckedAt: startedAt } });
      return Response.json({ restricted: result, requestId });
    }
    if (body.action === "remove") {
      return Response.json({ error: "Use Email health → Remove blocked emails to preview and confirm calendar removals." }, { status: 410 });
    }
    if (body.action !== "refresh")
      return Response.json(
        { error: "Unknown tracking action." },
        { status: 400 },
      );
    const eventIds = ids(body.eventIds);
    if (eventIds.length > 20)
      return Response.json(
        { error: "Select at most 20 events for invitation refresh." },
        { status: 400 },
      );
    if (!eventIds.length)
      return Response.json({ error: "Select an event." }, { status: 400 });
    const token =
      typeof body.lumaSessionToken === "string" && body.lumaSessionToken.trim()
        ? body.lumaSessionToken.trim()
        : await serverTrackingSession();
    if (!token || token.length > 8192 || /[\r\n]/.test(token))
      return Response.json(
        {
          error: "Reconnect Luma to refresh tracking.",
          code: "LUMA_SESSION_INVALID",
        },
        { status: 403 },
      );
    const manual = body.manual === true;
    if (body.details === true) {
      await enqueueDetails(
        eventIds,
        Array.isArray(body.targets) ? body.targets : [],
        true,
      );
    } else {
      await requestBulkRefresh(eventIds, manual);
    }
    const result = await runTrackingBatch(
      token,
      requestId,
      body.reconnect === true,
      eventIds,
      { detailsOnly: body.details === true },
    );
    if (
      (result.checked > 0 || ("pages" in result && Number(result.pages) > 0)) &&
      typeof body.lumaSessionToken === "string" &&
      body.lumaSessionToken.trim()
    )
      await saveTrackingSession(token);
    await audit(requestId, {
      action: "refresh",
      ...result,
      manual,
      eventCount: eventIds.length,
    });
    return Response.json({ ...result, requestId });
  } catch (error: any) {
    await audit(requestId, {
      action: "error",
      status: error.status || 500,
      code: error.code || "TRACKING_ERROR",
    });
    return failure(error, requestId);
  }
}
