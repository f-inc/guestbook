import { activeEmailSql, emailRemovalEnabled, removedEmails } from "./email-inactivity";
import { emailDecision } from "./email-policy";
import { issueEvidence } from "./email-issues";
import { eligibleInvitationRecipients } from "./invite-tracking-store";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./db";
import { emailableCredits, verificationBudget, emailableRequest, parseVerificationBatch } from "./emailable-client";

// The indexed community only: no live contacts/list or calendar guest scans.
const community = Prisma.sql`
  WITH addresses AS (
    SELECT lower(trim(coalesce(email_lower, email))) AS email, person_id AS "personId", name FROM luma_people
    UNION ALL
    SELECT lower(trim(coalesce(g.email_lower, g.email))), g.person_id, p.name
      FROM luma_event_guests g LEFT JOIN luma_people p ON p.person_id = g.person_id
    UNION ALL
    SELECT lower(trim("emailLower")), "personId", name FROM luma_invite_tracking
    UNION ALL SELECT "emailLower", "personId", name FROM email_addresses
    UNION ALL SELECT "emailLower", NULL, NULL FROM luma_calendar_opt_outs
  ), community AS (
    SELECT email, min("personId") AS "personId", min(name) AS name FROM addresses
    WHERE email IS NOT NULL AND email <> '' GROUP BY email
  )`;
const activeStatuses = ["running", "paused", "submission_unknown"];
const freshness = () => new Date(Date.now() - 30 * 86400000);

export async function verificationOverview(query = "", filter = "issues", offset = 0, db = prisma()) {
  const filterSql = filter === "inactive" ? Prisma.sql`NOT (${activeEmailSql(Prisma.sql`c.email`)})` : filter === "all" ? Prisma.sql`true`
    : filter === "bounced" ? Prisma.sql`EXISTS (SELECT 1 FROM luma_invite_tracking t WHERE t."emailLower" = c.email AND t."issueReason" = 'bounced')`
    : filter === "blocked" ? Prisma.sql`(v."lumaBlockedReason" IS NOT NULL OR (v.state = 'undeliverable' AND v."checkedAt" >= ${freshness()}))`
    : filter === "issues" ? Prisma.sql`(v.state IN ('undeliverable', 'risky', 'unknown') OR v."lumaBlockedReason" IS NOT NULL OR EXISTS (SELECT 1 FROM luma_calendar_opt_outs o WHERE o."emailLower" = c.email))`
    : Prisma.sql`coalesce(v.state, 'unchecked') = ${filter}`;
  const [summary, rows, run, bounced] = await Promise.all([
    db.$queryRaw<any[]>(Prisma.sql`${community}
      SELECT count(*)::int AS total,
        ${emailRemovalEnabled() ? Prisma.sql`(SELECT count(*)::int FROM email_inactive)` : Prisma.sql`0`} AS inactive,
        count(*) FILTER (WHERE ${activeEmailSql(Prisma.sql`c.email`)} AND v."lumaBlockedReason" IS NULL AND (v."checkedAt" IS NULL OR v."checkedAt" < ${freshness()}))::int AS pending,
        count(*) FILTER (WHERE v.state IN ('undeliverable','risky','unknown') OR v."lumaBlockedReason" IS NOT NULL OR EXISTS (SELECT 1 FROM luma_calendar_opt_outs o WHERE o."emailLower" = c.email))::int AS issues,
        count(*) FILTER (WHERE v."checkedAt" >= ${freshness()})::int AS fresh,
        count(*) FILTER (WHERE v.state = 'deliverable')::int AS deliverable,
        count(*) FILTER (WHERE v.state = 'undeliverable')::int AS undeliverable,
        count(*) FILTER (WHERE v.state = 'risky')::int AS risky,
        count(*) FILTER (WHERE v.state = 'unknown')::int AS unknown,
        count(*) FILTER (WHERE v."checkedAt" IS NULL)::int AS unchecked
      FROM community c LEFT JOIN email_addresses v ON v."emailLower" = c.email WHERE ${activeEmailSql(Prisma.sql`c.email`)}`),
    db.$queryRaw<any[]>(Prisma.sql`${community}
      SELECT c.email AS "emailLower", c."personId", c.name, coalesce(v.state, 'unchecked') AS state,
        ${emailRemovalEnabled() ? Prisma.sql`(SELECT "inactiveAt" FROM email_inactive i WHERE i."emailLower"=c.email)` : Prisma.sql`NULL::timestamptz`} AS "inactiveAt", ${emailRemovalEnabled() ? Prisma.sql`EXISTS (SELECT 1 FROM email_removal_items ri WHERE ri."emailLower"=c.email AND ri.status='succeeded')` : Prisma.sql`FALSE`} AS "hasRemoval", v.reason, v.score, v.flags, v."checkedAt", v."lumaBlockedReason", v."lumaCheckedAt", v."lumaClearedAt"
      FROM community c LEFT JOIN email_addresses v ON v."emailLower" = c.email
      WHERE ${filterSql} AND ${filter === "inactive" ? Prisma.sql`TRUE` : activeEmailSql(Prisma.sql`c.email`)} AND (strpos(c.email, lower(${query})) > 0 OR strpos(lower(coalesce(c.name, '')), lower(${query})) > 0)
      ORDER BY (v."lumaBlockedReason" IS NOT NULL) DESC,
        (v.state = 'undeliverable' AND v."checkedAt" >= ${freshness()}) DESC NULLS LAST, c.email LIMIT 51 OFFSET ${offset}`),
    db.emailVerificationRun.findFirst({ orderBy: { startedAt: "desc" } }),
    db.$queryRaw<any[]>`SELECT count(DISTINCT "emailLower")::int AS total FROM luma_invite_tracking WHERE "issueReason" = 'bounced'`,
  ]);
  const emails = rows.slice(0, 50).map(r => r.emailLower);
  const [tracking, optOuts] = await Promise.all([
    db.lumaInviteTracking.findMany({ where: { emailLower: { in: emails }, issueReason: { not: null } }, take: 5000 }),
    db.lumaCalendarOptOut.findMany({ where: { emailLower: { in: emails } } }),
  ]);
  const partial = run?.status === "running" || run?.status === "paused"
    ? await db.emailAddress.count({ where: { queuedRunId: run.id, checkedAt: { gte: run.startedAt } } }) : 0;
  const page = rows.slice(0, 50);
  // Match the address used to register, not another address on the same person.
  // Only enrich the displayed page from indexed history; no live Luma scans.
  const registrations = page.length ? await db.$queryRaw<{ emailLower: string; lastRegisteredAt: Date }[]>(Prisma.sql`
    SELECT lower(trim(coalesce(email_lower, email))) AS "emailLower",
      max(registered_at) AS "lastRegisteredAt"
    FROM luma_event_guests
    WHERE registered_at IS NOT NULL
      AND (email_lower IN (${Prisma.join(page.map((row) => row.emailLower))})
        OR (email_lower IS NULL AND lower(trim(email)) IN (${Prisma.join(page.map((row) => row.emailLower))})))
    GROUP BY lower(trim(coalesce(email_lower, email)))`) : [];
  const lastRegistrations = new Map(registrations.map((row) => [row.emailLower, row.lastRegisteredAt]));
  return {
    configured: Boolean(process.env.EMAILABLE_API_KEY?.trim()),
    summary: { ...summary[0], bounced: bounced[0]?.total || 0 },
    rows: page.map(row => {
      const sources = tracking.filter(t => t.emailLower === row.emailLower);
      return { ...row, lastRegisteredAt: lastRegistrations.get(row.emailLower) ?? null,
        decision: row.inactiveAt ? {status: "inactive", label: "Inactive", reason: "Removed from selected Luma calendars; excluded from invitations"} : row.hasRemoval ? {status: "cleanup", label: "Removal incomplete", reason: "Some calendar removals succeeded; invitations remain blocked"} : emailDecision(row), ...issueEvidence(sources),
        optOuts: optOuts.filter(o => o.emailLower === row.emailLower).map(o => o.calendarId),
        sources: sources.map(({ eventId, eventTitle, emailLower, removedAt }) => ({ eventId, eventTitle, emailLower, removedAt })) };
    }), historyTruncated: tracking.length === 5000, hasMore: rows.length > 50,
    run: run ? { id: run.id, status: run.status, total: run.total, skipped: run.skipped, processed: Math.min(run.total, run.processed + partial), startedAt: run.startedAt, completedAt: run.completedAt, error: run.error } : null,
  };
}

export async function startVerification(maxEmails = Number.MAX_SAFE_INTEGER, db = prisma(), getCredits = emailableCredits, scope?: { emails: string[]; eventIds: string[] }) {
  if (!process.env.EMAILABLE_API_KEY?.trim()) throw new Error("Set EMAILABLE_API_KEY on the server to enable verification.");
  const budget = verificationBudget(await getCredits(), maxEmails);
  if (!budget) throw Object.assign(new Error("No Emailable credits available. Add credits before starting a scan."), { status: 409, publicMessage: true });
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(72483192)::text`;
    const active = await tx.emailVerificationRun.findFirst({ where: { status: { in: activeStatuses } } });
    if (active) throw Object.assign(new Error("Another email scan is already active. Finish or resume it in Guests → Email health before starting a new audience."), { status: 409, publicMessage: true });
    await tx.$executeRaw(Prisma.sql`${community}
      INSERT INTO email_addresses ("emailLower", "personId", name)
      SELECT email, "personId", name FROM community
      ON CONFLICT ("emailLower") DO UPDATE SET "personId" = EXCLUDED."personId", name = EXCLUDED.name`);
    const id = randomUUID();
    const count = await tx.$executeRaw(Prisma.sql`${community}
      , candidates AS (
        SELECT v."emailLower" FROM email_addresses v JOIN community c ON v."emailLower" = c.email
        WHERE ${activeEmailSql(Prisma.sql`v."emailLower"`)} AND (v."checkedAt" IS NULL OR v."checkedAt" < ${freshness()}) AND v."lumaBlockedReason" IS NULL
          AND ${scope ? Prisma.sql`v."emailLower" = ANY(${scope.emails}::text[])` : Prisma.sql`true`}
        ORDER BY v."checkedAt" ASC NULLS FIRST, v."emailLower" LIMIT ${budget}
      )
      UPDATE email_addresses v SET "queuedRunId" = ${id}
      FROM candidates c WHERE v."emailLower" = c."emailLower"`);
    return tx.emailVerificationRun.create({ data: { id, eventIds: scope?.eventIds || [], total: count, status: count ? "running" : "completed", completedAt: count ? null : new Date() } });
  }, { timeout: 30000 });
}

export async function resumeVerification() {
  // A submission with an unknown outcome must be reconciled, not charged twice.
  return prisma().emailVerificationRun.updateMany({ where: { status: "paused" }, data: { status: "running", error: null, nextCheckAt: new Date() } });
}

export async function runVerificationTick(db = prisma(), request = emailableRequest, getCredits = emailableCredits) {
  const run = await db.emailVerificationRun.findFirst({ where: { status: "running", nextCheckAt: { lte: new Date() }, OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }] } });
  if (!run) return;
  const lease = new Date(Date.now() + 120000);
  const claimed = await db.emailVerificationRun.updateMany({ where: { id: run.id, status: "running", OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }] }, data: { lockUntil: lease } });
  if (!claimed.count) return;
  let submittingId: string | null = null;
  try {
    let batch = await db.emailVerificationBatch.findFirst({ where: { runId: run.id, status: { in: ["submitting", "waiting"] } }, orderBy: { createdAt: "asc" } });
    if (batch?.status === "submitting") {
      await db.emailVerificationRun.update({ where: { id: run.id }, data: { status: "submission_unknown", error: "A batch submission was interrupted. Check Emailable before retrying to avoid duplicate credit use." } });
      return;
    }
    if (!batch) {
      let pending = await db.emailAddress.findMany({ where: { queuedRunId: run.id }, orderBy: { emailLower: "asc" }, take: 1000, select: { emailLower: true, lumaBlockedReason: true, state: true, checkedAt: true, flags: true } });
      const originalPending = pending;
      const removed = await removedEmails(pending.map(r => r.emailLower), db);
      pending = pending.filter(r => !r.lumaBlockedReason && !removed.has(r.emailLower));
      const eventIds = Array.isArray(run.eventIds) ? run.eventIds as string[] : [];
      if (eventIds.length && pending.length) {
        const eligible = new Set<string>();
        for (const eventId of eventIds) {
          const result = await eligibleInvitationRecipients(pending.map(r => ({ email: r.emailLower })), db, eventId);
          result.eligible.forEach(r => eligible.add(r.email));
        }
        pending = pending.filter(r => eligible.has(r.emailLower));
      }
      const skipped = originalPending.filter(r => !pending.some(p => p.emailLower === r.emailLower));
      if (skipped.length) await db.$transaction(async tx => {
        await tx.emailAddress.updateMany({ where: { queuedRunId: run.id, emailLower: { in: skipped.map(r => r.emailLower) } }, data: { queuedRunId: null } });
        await tx.emailVerificationRun.update({ where: { id: run.id }, data: { skipped: { increment: skipped.length } } });
      });
      if (!pending.length && originalPending.length) return;
      if (!pending.length) {
        await db.emailVerificationRun.update({ where: { id: run.id }, data: { status: "completed", completedAt: new Date(), error: null } });
        return;
      }
      const available = await getCredits();
      const budget = verificationBudget(available, pending.length);
      if (!budget) {
        await db.emailVerificationRun.update({ where: { id: run.id }, data: { status: "paused", error: "No Emailable credits remaining. Add credits, then resume this scan." } });
        return;
      }
      const recipients = pending.slice(0, budget);
      // Persist intent before the billable POST; never blindly retry an ambiguous POST.
      batch = await db.emailVerificationBatch.create({ data: { id: randomUUID(), runId: run.id, emails: recipients.map((p) => p.emailLower) } });
      submittingId = batch.id;
      const response: any = await request("POST", { emails: batch.emails as string[] });
      if (typeof response.id !== "string" || !response.id) throw new Error("Emailable did not return a batch ID.");
      await db.emailVerificationBatch.update({ where: { id: batch.id }, data: { status: "waiting", providerId: response.id } });
      submittingId = null;
      return;
    }
    const response = await request("GET", { id: batch.providerId! });
    if (/paused/i.test((response as any)?.message || "")) throw new Error("Emailable batch is paused.");
    const { complete, results } = parseVerificationBatch(response, batch.emails as string[]);
    await db.$transaction(async (tx) => {
      if (results.length) {
        // A check is immutable. Identical partial polls use the same ID and do not create duplicate history.
        await tx.emailVerificationCheck.createMany({ data: results.map(r => ({
          id: createHash("sha256").update(JSON.stringify([batch!.id, r])).digest("hex"),
          emailLower: r.emailLower, provider: "emailable", providerBatchId: batch!.providerId,
          state: r.state, reason: r.reason, score: r.score, flags: r.flags,
        })), skipDuplicates: true });
        // Latest state is a cache; history above retains earlier checks.
        const values = Prisma.join(results.map((r) => Prisma.sql`(${r.emailLower}, ${r.state}, ${r.reason}, ${r.score}::integer, ${JSON.stringify(r.flags)}::jsonb, ${createHash("sha256").update(JSON.stringify([batch!.id, r])).digest("hex")})`));
        await tx.$executeRaw(Prisma.sql`UPDATE email_addresses v
          SET state = r.state, reason = r.reason, score = r.score, flags = r.flags, "checkedAt" = h."checkedAt"
          FROM (VALUES ${values}) AS r(email, state, reason, score, flags, id) JOIN email_verification_checks h ON h.id = r.id
          WHERE v."emailLower" = r.email AND v."queuedRunId" = ${run.id}`);
      }
      if (complete) {
        await tx.emailAddress.updateMany({ where: { queuedRunId: run.id, emailLower: { in: batch.emails as string[] } }, data: { queuedRunId: null } });
        await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { status: "completed" } });
        await tx.emailVerificationRun.update({ where: { id: run.id }, data: { processed: { increment: (batch.emails as string[]).length }, error: null } });
      }
    }, { timeout: 30000 });
  } catch (error: any) {
    if (submittingId && error.definitive) {
      await db.emailVerificationBatch.update({ where: { id: submittingId }, data: { status: "rejected" } });
      submittingId = null;
    }
    await db.emailVerificationRun.update({ where: { id: run.id }, data: {
      status: submittingId ? "submission_unknown" : "paused",
      error: submittingId ? "Batch submission could not be confirmed. Check Emailable before retrying to avoid duplicate credit use." : "Verification paused. Check the Emailable API key, credits, or connection, then resume. Cached results remain visible.",
    } });
  } finally {
    await db.emailVerificationRun.updateMany({ where: { id: run.id, lockUntil: lease }, data: { lockUntil: null, nextCheckAt: new Date(Date.now() + 30000) } });
  }
}

export async function verificationAudience(criteria: unknown, eventIds: string[]) {
  const { listIndexedAudienceInviteRecipients, normalizeIndexedAudienceCriteria } = await import("./db");
  const recipients = await listIndexedAudienceInviteRecipients(normalizeIndexedAudienceCriteria({ ...(criteria as object), excludeExistingEventIds: eventIds }));
  const allowed = new Set<string>();
  for (const eventId of eventIds) {
    const result = await eligibleInvitationRecipients(recipients, prisma(), eventId);
    result.eligible.forEach(r => allowed.add(r.email.trim().toLowerCase()));
  }
  const emails = [...allowed];
  let fresh = 0;
  for (let i = 0; i < emails.length; i += 5000) fresh += await prisma().emailAddress.count({ where: { emailLower: { in: emails.slice(i, i + 5000) }, checkedAt: { gte: freshness() } } });
  return { emails, eventIds, total: new Set(recipients.map(r => r.email.trim().toLowerCase())).size, eligible: emails.length, fresh, pending: emails.length - fresh };
}
