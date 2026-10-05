import { recordLumaIssue } from "./email-policy";
import { issueEvidence } from "./email-issues";
import { timelineIssues } from "./email-issues";
import { retryAfterMs } from "./rate-limit-retry";
import { fetchBulkPage } from "./tracking-bulk";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./db";
import { createLumaClient } from "./luma-client";
import {
  invitationMessages,
  latestInviteStatus,
  emailStatus,
  mergeInvitationMessages,
  bulkInvitationStatus,
} from "../../invite-tracking";
import { nextTrackingCheck, trackingRetryDelay } from "./tracking-policy";

const db = () => prisma();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const trackingCredentialKey = (token: string) =>
  `credential:${createHash("sha256").update(token).digest("hex")}`;

export async function enqueueDetails(
  eventIds: string[],
  targets: { eventId: string; personId?: string; emailLower?: string }[],
  manual = false,
) {
  const addresses = targets
    .filter(
      (t) =>
        t && eventIds.includes(t.eventId) && typeof t.emailLower === "string",
    )
    .slice(0, 50)
    .map((t) => ({
      eventId: t.eventId,
      emailLower: t.emailLower!.trim().toLowerCase(),
    }));
  if (addresses.length)
    await db().lumaInviteTracking.updateMany({
      where: { OR: addresses },
      data: { nextCheckAt: new Date(), priority: 30, retryCount: 0 },
    });
  const valid = targets
    .filter(
      (t) =>
        t && eventIds.includes(t.eventId) && typeof t.personId === "string",
    )
    .slice(0, 50)
    .map((t) => ({ eventId: t.eventId, personId: t.personId as string }));
  if (!valid.length) return;
  const guests = await db().lumaEventGuest.findMany({
    where: { OR: valid, emailLower: { not: null }, lumaUserId: { not: null } },
    include: { person: true, event: true },
    take: 50,
  });
  await seedGuests(guests, 30, true);
}
async function seedGuests(guests: any[], priority = 0, manual = false) {
  if (!guests.length) return;
  const pairs = guests.map((g) => ({
    eventId: g.eventId,
    emailLower: g.emailLower,
  }));
  await db().lumaInviteTracking.createMany({
    skipDuplicates: true,
    data: guests.map((g) => ({
      eventId: g.eventId,
      emailLower: g.emailLower,
      personId: g.personId,
      lumaUserId: g.lumaUserId,
      name: g.person.name,
      eventTitle: g.event.title,
      requestedAt: g.invitedAt,
      priority,
    })),
  });
  const now = new Date();
  // Keep fresh data fresh. Page visits don't reset the polling schedule.
  if (manual)
    await db().lumaInviteTracking.updateMany({
      where: {
        AND: [
          { OR: pairs },
          {
            OR: [
              { checkedAt: { lt: new Date(Date.now() - 60_000) } },
              { checkedAt: null, nextCheckAt: null },
            ],
          },
        ],
      },
      data: { nextCheckAt: now, priority },
    });
  await db().lumaInviteTracking.updateMany({
    where: { OR: pairs, nextCheckAt: { lte: now } },
    data: { priority },
  });
}

// One shared lease also enforces a conservative global budget across tabs and processes.
// Sequential requests deliberately stay below 30/minute; private API limits are undocumented.
export async function runTrackingBatch(
  token: string,
  requestId: string,
  reconnect = false,
  eventIds?: string[],
  services: {
    database?: any;
    client?: any;
    wait?: (ms: number) => Promise<void>;
    detailsOnly?: boolean;
  } = {},
) {
  const db = () => services.database || prisma();
  const wait = services.wait || sleep;
  const credentialKey = trackingCredentialKey(token);
  if (reconnect)
    await db().lumaTrackingState.deleteMany({ where: { key: credentialKey } });
  const paused = await db().lumaTrackingState.findUnique({
    where: { key: credentialKey },
  });
  if (paused?.active)
    throw Object.assign(
      new Error("Reconnect Luma. Cached results remain available."),
      { code: "LUMA_SESSION_INVALID", status: 403 },
    );
  const owner = randomUUID();
  await db().lumaTrackingState.upsert({
    where: { key: "worker" },
    create: { key: "worker" },
    update: {},
  });
  const claim = await db().lumaTrackingState.updateMany({
    where: {
      key: "worker",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { owner, leaseUntil: new Date(Date.now() + 120_000) },
  });
  if (!claim.count) return { checked: 0, busy: true };
  let checked = 0;
  let pages = 0;
  let requests = 0;
  let cooldown = 2000;
  const started = Date.now();
  const client =
    services.client ||
    createLumaClient({
      logger: async (requestId, event, details) => {
        await mkdir(".debug", { recursive: true });
        await appendFile(
          ".debug/luma-api.log",
          JSON.stringify({
            timestamp: new Date().toISOString(),
            requestId,
            event,
            details: {
              operation: "invitation tracking",
              path: details.path,
              status: details.status,
              durationMs: details.durationMs,
            },
          }) + "\n",
        );
      },
      fetchImpl: async (url, init) => {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(12000),
        });
        if (
          response.status === 429 ||
          (response.headers.has("x-ratelimit-remaining") &&
            Number(response.headers.get("x-ratelimit-remaining")) === 0)
        ) {
          const retryDelay = retryAfterMs(response.headers.get("retry-after"));
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          cooldown = Math.max(
            60_000,
            retryDelay || 0,
            Number.isFinite(reset) ? reset * 1000 - Date.now() : 0,
          );
        }
        return response;
      },
    });
  try {
    while (requests < 12 && Date.now() - started < 25_000) {
      const row = await db().lumaInviteTracking.findFirst({
        where: {
          nextCheckAt: { lte: new Date() },
          priority: { gte: 20 },
          ...(eventIds?.length ? { eventId: { in: eventIds } } : {}),
        },
        orderBy: [{ priority: "desc" }, { nextCheckAt: "asc" }],
      });
      const job =
        services.detailsOnly || row?.priority >= 30
          ? null
          : await db().lumaTrackingState.findFirst({
              where: {
                key: eventIds?.length
                  ? { in: eventIds.map((id) => `bulk:${id}`) }
                  : { startsWith: "bulk:" },
                OR: [
                  {
                    active: true,
                    OR: [
                      { leaseUntil: null },
                      { leaseUntil: { lte: new Date() } },
                    ],
                  },
                  { active: false, leaseUntil: { lte: new Date() } },
                ],
              },
              orderBy: { updatedAt: "asc" },
            });
      if (job) {
        requests++;
        try {
          checked += await fetchBulkPage(job, client, token, requestId, db());
          pages++;
        } catch (error: any) {
          if (error.code === "LUMA_SESSION_INVALID") {
            await db().lumaTrackingState.upsert({
              where: { key: credentialKey },
              create: { key: credentialKey, active: true },
              update: { active: true },
            });
            throw error;
          }
          if (error.status === 429) cooldown = Math.max(cooldown, 60_000);
          await db().lumaTrackingState.update({
            where: { key: job.key },
            data: {
              leaseUntil: new Date(Date.now() + Math.max(cooldown, 60_000)),
              owner: error.status === 429 ? "RATE_LIMITED" : "REFRESH_FAILED",
            },
          });
          throw error;
        }
        if (cooldown > 2000) break;
        await wait(2000);
        continue;
      }
      if (!row) break;
      const where = {
        eventId_emailLower: {
          eventId: row.eventId,
          emailLower: row.emailLower,
        },
      };
      // Resolve new recipients from the existing index only; never scan a calendar.
      let userId = row.lumaUserId;
      if (!userId) {
        const guest = await db().lumaEventGuest.findFirst({
          where: { eventId: row.eventId, emailLower: row.emailLower },
          select: { lumaUserId: true },
        });
        userId = guest?.lumaUserId || null;
      }
      if (!userId) {
        await db().lumaInviteTracking.update({
          where,
          data: {
            nextCheckAt: new Date(
              Date.now() + trackingRetryDelay(row.retryCount),
            ),
            retryCount: { increment: 1 },
            lastError: "GUEST_NOT_INDEXED",
            priority: 0,
          },
        });
        continue;
      }
      requests++;
      try {
        const timeline = await client.privateGet({
          requestId,
          lumaSessionToken: token,
          path: "/event/admin/get-guest-timeline",
          params: { event_api_id: row.eventId, user_api_id: userId },
          operation: "invitation tracking",
        });
        const incoming = invitationMessages(timeline);
        const messages = mergeInvitationMessages(
          Array.isArray(row.messages) ? row.messages : [],
          incoming,
        );
        const entries = Array.isArray(timeline) ? timeline : timeline.entries;
        const states = entries.map((e: any) => emailStatus(e.email || {}));
        const issue = states.includes("reported")
          ? "reported"
          : states.includes("bounced")
            ? "bounced"
            : null;
        let status = latestInviteStatus(messages, row.requestedAt, row.status);
        if ((row.bulkInvite as any)?.id)
          status = bulkInvitationStatus({ ...row, messages }, row.bulkInvite);
        const now = new Date();
        // Details are on demand. New sends get short follow-up checks until observed.
        const nextCheckAt =
          row.priority === 20 &&
          ["processing", "unconfirmed", "unknown", "sent"].includes(status)
            ? nextTrackingCheck(status, row.requestedAt, now)
            : null;
        // Don't overwrite a new send that happened while this request was in flight.
        await db().lumaInviteTracking.updateMany({
          where: {
            eventId: row.eventId,
            emailLower: row.emailLower,
            requestedAt: row.requestedAt,
          },
          data: {
            messages,
            issueMessages: mergeInvitationMessages(
              Array.isArray(row.issueMessages) ? row.issueMessages : [],
              timelineIssues(timeline),
            ),
            status,
            checkedAt: now,
            nextCheckAt,
            lumaUserId: userId,
            priority: nextCheckAt ? 20 : 0,
            retryCount: 0,
            lastError: null,
            ...(issue ? { issueReason: issue } : {}),
          },
        });
        if (issue) {
          const evidence = issueEvidence([{ issueMessages: timelineIssues(timeline) }]);
          await recordLumaIssue(row.emailLower, issue, evidence.lastFailureAt ? new Date(evidence.lastFailureAt) : null, db());
        }
        checked++;
        if (cooldown > 2000) break;
        await wait(2000);
      } catch (error: any) {
        if (error.code === "LUMA_SESSION_INVALID") {
          await db().lumaTrackingState.upsert({
            where: { key: credentialKey },
            create: { key: credentialKey, active: true },
            update: { active: true },
          });
          throw error;
        }
        await db().lumaInviteTracking.update({
          where,
          data: {
            retryCount: { increment: 1 },
            lastError:
              error.status === 429
                ? "RATE_LIMITED"
                : error.code === "LUMA_TRACKING_ACCESS_DENIED"
                  ? "ACCESS_UNAVAILABLE"
                  : "REFRESH_FAILED",
            nextCheckAt: new Date(
              Date.now() +
                trackingRetryDelay(
                  row.retryCount,
                  error.status === 429 ? cooldown : undefined,
                ),
            ),
            priority: row.priority,
          },
        });
        if (error.status === 429) {
          cooldown = Math.max(cooldown, 60_000);
          break;
        }
        await wait(2000);
      }
    }
    return { checked, pages, busy: false };
  } finally {
    await db().lumaTrackingState.updateMany({
      where: { key: "worker", owner },
      data: { owner: null, leaseUntil: new Date(Date.now() + cooldown) },
    });
  }
}
