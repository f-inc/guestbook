import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { lumaApiKeys, type LumaApiKey } from "./api-keys";
import { emailDecision, VERIFICATION_MAX_AGE_MS } from "./email-policy";
import { activeEmailSql, emailRemovalEnabled } from "./email-inactivity";

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status, publicMessage: true });
export function requireRemovalEnabled() {
  if (!emailRemovalEnabled()) throw fail("Email removal needs its database migration and server configuration before it can be used.", 503);
}
export function calendarIdentity(data: any) {
  const c = data?.calendar || data;
  const id = c?.api_id || c?.id;
  if (typeof id !== "string" || !id.startsWith("cal-")) throw fail("Unable to verify the calendar associated with a Luma API key.");
  return { id, name: typeof c.name === "string" ? c.name : id };
}
async function calendarForKey(key: LumaApiKey, fetcher = fetch) {
  const response = await fetcher("https://public-api.luma.com/v1/calendars/get", {
    headers: { "x-luma-api-key": key.value }, signal: AbortSignal.timeout(15000), cache: "no-store",
  });
  if (!response.ok) throw fail("Reconnect the Luma calendar API key before removing contacts.");
  return calendarIdentity(await response.json());
}
export async function removalCalendars(fetcher = fetch) {
  const keys = lumaApiKeys();
  if (!keys.length || keys.length > 20) throw fail("Configure between 1 and 20 Luma calendar API keys.");
  const scopes = [];
  for (const key of keys) {
    const scope = await calendarForKey(key, fetcher);
    if (!scopes.some(s => s.id === scope.id)) scopes.push({ ...scope, envName: key.envName });
  }
  return scopes;
}
export async function previewRemoval(input: any, db: any = prisma()) {
  requireRemovalEnabled();
  const available = await removalCalendars();
  const ids: string[] = [...new Set<string>((Array.isArray(input.calendarIds) ? input.calendarIds : []).filter(x => typeof x === "string"))];
  if (!ids.length || ids.some(id => !available.some(c => c.id === id))) throw fail("Choose a connected Luma calendar.", 400);
  const calendars = available.filter(c => ids.includes(c.id));
  const selected = Array.isArray(input.emails) ? [...new Set<string>(input.emails.filter(e => typeof e === "string").map(e => e.trim().toLowerCase()))] : [];
  if (input.scope !== "all" && !selected.length) throw fail("Select blocked emails first.", 400);
  if (selected.length > 1000) throw fail("Select at most 1,000 addresses, or use all matching blocked emails.", 400);
  const q = String(input.query || "").slice(0, 120);
  const rows = await db.$queryRaw(Prisma.sql`SELECT v."emailLower", v.name, v.state, v."checkedAt", v."lumaBlockedReason"
    FROM email_addresses v
    WHERE (v."lumaBlockedReason" IS NOT NULL OR (v.state = 'undeliverable' AND v."checkedAt" >= ${new Date(Date.now() - VERIFICATION_MAX_AGE_MS)}))
      AND ${activeEmailSql(Prisma.sql`v."emailLower"`)}
      AND ${input.scope === "all" ? Prisma.sql`(strpos(v."emailLower", lower(${q})) > 0 OR strpos(lower(coalesce(v.name, '')), lower(${q})) > 0)` : Prisma.sql`v."emailLower" IN (${Prisma.join(selected)})`}
    ORDER BY v."emailLower" LIMIT 10001`);
  if (!rows.length) throw fail("No currently blocked, active addresses match this selection.");
  if (rows.length > 10000 || rows.length * calendars.length > 50000) throw fail("This selection is too large. Narrow the search or choose fewer calendars.");
  const id = randomUUID();
  await db.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`INSERT INTO email_removal_jobs (id, calendars, "expiresAt") VALUES (${id}, ${JSON.stringify(calendars)}::jsonb, now() + interval '15 minutes')`);
    const items = rows.flatMap(r => calendars.map(c => ({ email: r.emailLower, name: r.name, reason: emailDecision(r).reason, calendar: c.id })));
    await tx.$executeRaw(Prisma.sql`INSERT INTO email_removal_items ("jobId", "emailLower", "calendarId", name, reason)
      SELECT ${id}, x.email, x.calendar, x.name, x.reason FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(email text, calendar text, name text, reason text)`);
  });
  return removalStatus(id, 0, db);
}
export async function removalStatus(id?: string, offset = 0, db: any = prisma()) {
  requireRemovalEnabled();
  const jobs = await db.$queryRaw(Prisma.sql`SELECT * FROM email_removal_jobs WHERE ${id ? Prisma.sql`id = ${id}` : Prisma.sql`status <> 'draft'`} ORDER BY "createdAt" DESC LIMIT 1`);
  const job = jobs[0];
  if (!job) return { job: null };
  const [counts, rows, hidden] = await Promise.all([
    db.$queryRaw(Prisma.sql`SELECT count(DISTINCT "emailLower")::int AS emails, count(*)::int AS total,
      count(*) FILTER (WHERE status='succeeded')::int AS succeeded,
      count(*) FILTER (WHERE status='failed')::int AS failed,
      count(*) FILTER (WHERE status='unknown')::int AS unknown,
      count(*) FILTER (WHERE status='skipped')::int AS skipped
      FROM email_removal_items WHERE "jobId"=${job.id}`),
    db.$queryRaw(Prisma.sql`SELECT "emailLower", name, reason, "calendarId", status, error FROM email_removal_items WHERE "jobId"=${job.id} ORDER BY "emailLower", "calendarId" LIMIT 51 OFFSET ${offset}`),
    db.$queryRaw(Prisma.sql`SELECT count(*)::int AS total FROM (
      SELECT p.person_id FROM guestbook_person_email_addresses p
      WHERE p.person_id IN (SELECT pe.person_id FROM guestbook_person_email_addresses pe JOIN email_removal_items it ON it."emailLower"=pe.email AND it."jobId"=${job.id})
      GROUP BY p.person_id HAVING bool_and(EXISTS (SELECT 1 FROM email_inactive i WHERE i."emailLower"=p.email) OR EXISTS (SELECT 1 FROM email_removal_items it WHERE it."jobId"=${job.id} AND it."emailLower"=p.email))
    ) affected`),
  ]);
  return { job: { ...job, calendars: job.calendars.map(({ id, name }) => ({ id, name })), ...counts[0], affectedPeople: hidden[0].total }, rows: rows.slice(0,50), hasMore: rows.length > 50 };
}
export async function confirmRemoval(id: string, confirmation: string, db: any = prisma()) {
  requireRemovalEnabled();
  if (confirmation !== "REMOVE_BLOCKED_EMAILS") throw fail("Confirm the removal preview first.", 400);
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(72483193)::text`;
    const active = await tx.$queryRaw`SELECT id FROM email_removal_jobs WHERE status='running' LIMIT 1`;
    if (active.length) throw fail("A removal job is already running. Wait for it to finish.");
    const updated = await tx.$executeRaw(Prisma.sql`UPDATE email_removal_jobs SET status='running', "confirmedAt"=now() WHERE id=${id} AND status='draft' AND "expiresAt">now()`);
    if (!updated) throw fail("This preview expired or was already confirmed. Create a new preview.");
  });
}
// Never retry an uncertain POST automatically. A timeout or server error might
// mean Luma removed the contact, even when the response was not received.
export async function removeCalendarEmail(scope: { id: string; envName: string }, email: string, fetcher = fetch): Promise<{ status: string; error?: string }> {
  const key = lumaApiKeys().find(k => k.envName === scope.envName);
  if (!key) return { status: "failed", error: "Calendar API key is missing. Reconnect it and retry." };
  try {
    if ((await calendarForKey(key, fetcher)).id !== scope.id) return { status: "failed", error: "Calendar key changed. Create a new preview for the correct calendar." };
  } catch { return { status: "failed", error: "Could not verify the calendar. Reconnect Luma and retry." }; }
  try {
    const response = await fetcher("https://public-api.luma.com/v1/calendars/contacts/remove", {
      method: "POST", headers: { "x-luma-api-key": key.value, "content-type": "application/json" }, body: JSON.stringify({ email }), signal: AbortSignal.timeout(20000),
    });
    if (response.ok) return { status: "succeeded" };
    if (response.status >= 400 && response.status < 500 && response.status !== 408) return { status: "failed", error: `Luma rejected removal (HTTP ${response.status}). Review the calendar connection before retrying.` };
  } catch {}
  return { status: "unknown", error: "Luma did not confirm the result. Check this contact in Luma before making a new removal request." };
}
export async function runRemovalTick(db: any = prisma(), remove = removeCalendarEmail) {
  if (!emailRemovalEnabled()) return;
  // Expired claims are uncertain, not safe to put back in the queue.
  await db.$executeRaw`UPDATE email_removal_items SET status='unknown', error='Worker stopped before confirmation. Check the contact in Luma.' WHERE status='processing' AND "startedAt" < now() - interval '2 minutes'`;
  const attempt = randomUUID();
  const claimed = await db.$queryRaw(Prisma.sql`WITH candidate AS (
    SELECT i."jobId", i."emailLower", i."calendarId" FROM email_removal_items i JOIN email_removal_jobs j ON j.id=i."jobId"
    WHERE j.status='running' AND i.status='pending' ORDER BY i."emailLower", i."calendarId" FOR UPDATE OF i SKIP LOCKED LIMIT 1
  ) UPDATE email_removal_items i SET status='processing', "attemptId"=${attempt}, "startedAt"=now()
    FROM candidate c WHERE i."jobId"=c."jobId" AND i."emailLower"=c."emailLower" AND i."calendarId"=c."calendarId" RETURNING i.*`);
  const item = claimed[0];
  if (item) {
    const jobs = await db.$queryRaw(Prisma.sql`SELECT calendars FROM email_removal_jobs WHERE id=${item.jobId}`);
    const scope = jobs[0]?.calendars.find(c => c.id === item.calendarId);
    const row = await db.emailAddress.findUnique({ where: { emailLower: item.emailLower } });
    const result = emailDecision(row).status !== "blocked"
      ? { status: "skipped", error: "Address is no longer blocked. Not removed." }
      : scope ? await remove(scope, item.emailLower) : { status: "failed", error: "Calendar scope is missing." };
    await db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${item.emailLower}, 0))::text`);
      const updated = await tx.$executeRaw(Prisma.sql`UPDATE email_removal_items SET status=${result.status}, error=${result.error || null}, "completedAt"=now()
        WHERE "jobId"=${item.jobId} AND "emailLower"=${item.emailLower} AND "calendarId"=${item.calendarId} AND "attemptId"=${attempt} AND status='processing'`);
      if (!updated || result.status !== "succeeded") return;
      await tx.$executeRaw(Prisma.sql`INSERT INTO email_inactive ("emailLower", "jobId")
        SELECT ${item.emailLower}, ${item.jobId} WHERE NOT EXISTS (
          SELECT 1 FROM email_removal_items WHERE "jobId"=${item.jobId} AND "emailLower"=${item.emailLower} AND status <> 'succeeded'
        ) ON CONFLICT ("emailLower") DO NOTHING`);
    });
  }
  await db.$executeRaw`UPDATE email_removal_jobs j SET status=CASE WHEN EXISTS (SELECT 1 FROM email_removal_items i WHERE i."jobId"=j.id AND i.status IN ('failed','unknown')) THEN 'needs_attention' ELSE 'completed' END, "completedAt"=now()
    WHERE j.status='running' AND NOT EXISTS (SELECT 1 FROM email_removal_items i WHERE i."jobId"=j.id AND i.status IN ('pending','processing'))`;
  return Boolean(item);
}
export async function retryFailedRemoval(id: string, db: any = prisma()) {
  requireRemovalEnabled();
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(72483193)::text`;
    const running = await tx.$queryRaw`SELECT id FROM email_removal_jobs WHERE status='running' LIMIT 1`;
    if (running.length) throw fail("A removal job is already running.");
    const updated = await tx.$executeRaw(Prisma.sql`UPDATE email_removal_jobs SET status='running', "completedAt"=NULL WHERE id=${id} AND status='needs_attention'`);
    if (!updated) throw fail("This job cannot be retried.");
    await tx.$executeRaw(Prisma.sql`UPDATE email_removal_items SET status='pending', error=NULL WHERE "jobId"=${id} AND status='failed'`);
  });
}

export async function runRemovalBatch() {
  // Bounded work independent of browser polling. Each claim has its own lease.
  const started = Date.now();
  for (let i = 0; i < 5 && Date.now() - started < 40000; i++) {
    if (!await runRemovalTick()) break;
  }
}
