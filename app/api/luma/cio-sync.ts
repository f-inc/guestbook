import { randomUUID, createHash } from "node:crypto";
import { prisma } from "./db";
import { buildCioProjection, cioRuntimeMode, cioRetryDelay, normalizeCioEmail, requireCioProductionIdentity } from "./cio-projection";

export async function loadCioProjection(email: string, db = prisma()) {
  const [guests, optOuts, address, inactive, peopleByEmail, previous, tagDefinitions] = await Promise.all([
    db.lumaEventGuest.findMany({ where: { emailLower: email }, include: { event: { include: { syncState: true } }, person: true }, take: 1001 }),
    db.lumaCalendarOptOut.findMany({ where: { emailLower: email } }),
    db.emailAddress.findUnique({ where: { emailLower: email } }),
    db.emailInactive.findUnique({ where: { emailLower: email } }),
    db.lumaPerson.findMany({ where: { emailLower: email }, take: 101 }),
    db.cioProjectionQueue.findUnique({ where: { email }, select: { answerState: true } }),
    db.guestTag.findMany({ where: { semanticKey: { in: ["cio_blacklist", "cio_no_invite"] } }, select: { name: true, semanticKey: true } }),
  ]);
  if (guests.length > 1000) throw new Error("too_many_registrations");
  if (peopleByEmail.length > 100) throw new Error("too_many_people");
  // Do not silently create a newly marketable identity when a Luma person
  // changed email. An operator resolves these aliases using CIO's cio_id.
  const people = [...new Set(guests.map(g => g.personId))];
  const conflicts = people.length ? await db.lumaEventGuest.findFirst({
    where: { personId: { in: people }, emailLower: { not: email } }, select: { personId: true },
  }) : null;
  const coverageRows = guests.length ? await db.cioSyncControl.findMany({
    where: { id: { in: [...new Set(guests.map(g => `coverage:${g.eventId}`))] } }, select: { id: true, data: true },
  }) : [];
  const coverage = Object.fromEntries(coverageRows.map(r => [r.id.slice("coverage:".length), (r.data as any).completedBefore]));
  return buildCioProjection({ email, guests, optOuts, address, inactive: Boolean(inactive), people: peopleByEmail,
    previousAnswers: (previous?.answerState || {}) as any, tagDefinitions,
    coverage, identityConflict: Boolean(conflicts), newsletterCalendarIds: (process.env.CIO_NEWSLETTER_CALENDAR_IDS || "").split(",").map(s => s.trim()).filter(Boolean) });
}

export async function sendCioProjection(email: string, attributes: Record<string, unknown>, fetchImpl = fetch,
  env: Record<string, string | undefined> = process.env) {
  if (cioRuntimeMode(env) !== "send") throw new Error("cio_sending_disabled");
  const normalized = normalizeCioEmail(email);
  if (!normalized) throw new Error("invalid_email");
  email = normalized;
  const allowed = (env.CIO_SYNC_ALLOWED_EMAILS || "").split(",").map(normalizeCioEmail).filter(Boolean);
  if (env.CIO_SYNC_FULL_ROLLOUT !== "true" && !allowed.includes(email)) throw new Error("outside_canary");
  for (const key of Object.keys(attributes)) if (!key.startsWith("finc_luma_")) throw new Error("unowned_attribute");
  const eu = env.CUSTOMERIO_REGION === "eu";
  // Resolve every write afresh: email-only and external-ID profiles coexist.
  // Never assign an external ID, merge profiles, or move an existing email.
  const lookup = await fetchImpl(`${eu ? "https://api-eu.customer.io" : "https://api.customer.io"}/v1/customers?${new URLSearchParams({ email })}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${env.CUSTOMERIO_APP_API_KEY}` },
  });
  requireCioResponse(lookup);
  const data = await lookup.json();
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) throw new Error("cio_identity_response_invalid");
  const matches = data.results;
  if (matches.length > 1 || matches.some((p: any) => normalizeCioEmail(p?.email) !== email ||
      typeof p?.cio_id !== "string" || !/^[a-zA-Z0-9]+$/.test(p.cio_id))) {
    throw Object.assign(new Error("cio_identity_ambiguous"), { status: 409 });
  }
  const existing = matches[0];
  // Restrictions still reach an existing profile. A restricted person is never
  // newly imported, even after an operator enables reviewed profile creation.
  if (!existing && attributes.finc_luma_marketing_blocked === true) throw new Error("cio_profile_excluded");
  if (!existing && attributes.finc_luma_identity_review === true) {
    throw Object.assign(new Error("cio_identity_review_required"), { status: 409 });
  }
  if (!existing && env.CIO_SYNC_PROFILE_MODE !== "create_reviewed") throw new Error("cio_profile_creation_disabled");
  if (!existing && attributes.finc_luma_registration_count === 0) throw new Error("cio_profile_without_registration");
  const identifier = existing ? `cio_${existing.cio_id}` : email;
  const origin = eu ? "https://track-eu.customer.io" : "https://track.customer.io";
  const response = await fetchImpl(`${origin}/api/v1/customers/${encodeURIComponent(identifier)}`, {
    method: "PUT", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", Authorization: `Basic ${Buffer.from(`${env.CUSTOMERIO_SITE_ID}:${env.CUSTOMERIO_TRACK_API_KEY}`).toString("base64")}` },
    // _update also prevents creation if the resolved profile is deleted in flight.
    body: JSON.stringify(existing ? { ...attributes, _update: true } : { ...attributes, email }),
  });
  requireCioResponse(response);
}

function requireCioResponse(response: Response) {
  // Provider bodies may contain PII or sensitive request details. Do not log them.
  if (!response.ok) throw Object.assign(new Error(`cio_http_${response.status}`), { status: response.status, retryAfter: response.headers.get("retry-after") });
}

export async function runCioProjectionBatch({ db, fetchImpl = fetch, maxItems = 20, budgetMs = 20_000 }: {
  db?: ReturnType<typeof prisma>; fetchImpl?: typeof fetch; maxItems?: number; budgetMs?: number;
} = {}) {
  if (cioRuntimeMode() !== "send") return { mode: cioRuntimeMode(), processed: 0 };
  db ||= prisma();
  const delivery = (await db.cioSyncControl.findUnique({ where: { id: "delivery" } }))?.data as any;
  if (delivery?.requiresReview || (delivery?.retryAt && Date.parse(delivery.retryAt) > Date.now())) {
    return { mode: "send", paused: true, processed: 0, reason: delivery.error, retryAt: delivery.retryAt || null };
  }
  const deadline = Date.now() + Math.min(20_000, budgetMs);
  const allowed = process.env.CIO_SYNC_FULL_ROLLOUT === "true" ? null : (process.env.CIO_SYNC_ALLOWED_EMAILS || "").split(",").map(normalizeCioEmail).filter(Boolean);
  const counts = { mode: "send", processed: 0, sent: 0, unchanged: 0, skipped: 0, held: 0, failed: 0 };
  while (counts.processed < Math.min(20, maxItems) && Date.now() < deadline) {
    const token = randomUUID();
    const jobs = await db.$queryRawUnsafe<any[]>(`
      WITH candidate AS (
        SELECT email FROM cio_projection_queue WHERE revision > sent_revision AND attempts < 10
          AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
          AND ($2::text[] IS NULL OR email = ANY($2::text[]))
          AND NOT EXISTS (SELECT 1 FROM cio_sync_control WHERE id = 'delivery' AND
            (data->>'requiresReview' = 'true' OR (data->>'retryAt')::timestamptz > now()))
        ORDER BY CASE WHEN $3::boolean THEN 0 ELSE priority END DESC, next_attempt_at, email
        FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE cio_projection_queue q SET lease_token = $1, lease_until = now() + interval '120 seconds'
        FROM candidate c WHERE q.email = c.email RETURNING q.*`, token, allowed, counts.processed % 5 === 4);
    const job = jobs[0]; if (!job) break;
    counts.processed++;
    let sent = false;
    try {
      const projection = await loadCioProjection(job.email, db);
      // If a source transaction committed while reading, rebuild next pass.
      const current = await db.cioProjectionQueue.findUnique({ where: { email: job.email } });
      if (current?.leaseToken !== token || current.revision !== job.revision) {
        await releaseCioJob(db, job.email, token); counts.skipped++; continue;
      }
      if (projection.hash === job.payload_hash) counts.unchanged++;
      else if (!projection.hasOwnedFacts && !job.payload_hash) counts.skipped++;
      else {
        await sendCioProjection(job.email, { ...projection.attrs, finc_luma_synced_at: Math.floor(Date.now() / 1000) }, fetchImpl);
        counts.sent++;
        sent = true;
      }
      // Ack only the claimed revision. A concurrent update remains pending.
      await db.$executeRawUnsafe(`UPDATE cio_projection_queue SET sent_revision = $3,
        pending_since = CASE WHEN revision = $3 THEN NULL ELSE pending_since END,
        priority = CASE WHEN revision = $3 THEN 0 ELSE priority END,
        payload_hash = $4, answer_state = $6::jsonb, last_synced_at = CASE WHEN $5::boolean THEN now() ELSE last_synced_at END, attempts = 0, last_error = NULL,
        lease_token = NULL, lease_until = NULL WHERE email = $1 AND lease_token = $2`,
        job.email, token, job.revision, projection.hasOwnedFacts || job.payload_hash ? projection.hash : null, sent, JSON.stringify(projection.answerState));
    } catch (error: any) {
      // Keep new people pending without exhausting retries while creation is off.
      // They resume automatically after the separately reviewed rollout switch.
      if (["cio_profile_creation_disabled", "cio_profile_excluded", "cio_profile_without_registration"].includes(error.message)) {
        counts.held++;
        await db.$executeRawUnsafe(`UPDATE cio_projection_queue SET last_error = $3,
          next_attempt_at = now() + interval '15 minutes', lease_token = NULL, lease_until = NULL
          WHERE email = $1 AND lease_token = $2`, job.email, token, error.message);
        continue;
      }
      counts.failed++;
      const status = Number(error.status) || 0;
      const permanent = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
      const retryMs = cioRetryDelay(job.attempts, error.retryAfter || null);
      const code = /^(cio_http_\d+|cio_identity_ambiguous|cio_identity_review_required|cio_identity_response_invalid|projection_too_large|too_many_registrations|invalid_email|outside_canary)$/.test(error.message) ? error.message : "projection_failed";
      await db.$executeRawUnsafe(`UPDATE cio_projection_queue SET
        attempts = CASE WHEN revision = $5 THEN $3 ELSE attempts END,
        last_error = $4, next_attempt_at = now() + ($6::double precision * interval '1 millisecond'),
        lease_token = NULL, lease_until = NULL WHERE email = $1 AND lease_token = $2`,
        job.email, token, permanent ? 10 : job.attempts + 1, code, job.revision, retryMs);
      if ([401, 403, 429].includes(status)) {
        const data = { error: code, requiresReview: status !== 429,
          retryAt: status === 429 ? new Date(Date.now() + retryMs).toISOString() : null };
        await db.cioSyncControl.upsert({ where: { id: "delivery" }, create: { id: "delivery", data }, update: { data, updatedAt: new Date() } });
        break;
      }
    }
  }
  return counts;
}
async function releaseCioJob(db: ReturnType<typeof prisma>, email: string, token: string) {
  await db.$executeRawUnsafe(`UPDATE cio_projection_queue SET lease_token = NULL, lease_until = NULL WHERE email = $1 AND lease_token = $2`, email, token);
}

// Bounded historical projection of the existing Guestbook index. The cursor and
// enqueued batch commit together; this never emits historical CIO track events.
export async function seedCioQueue(limit = 200, db?: ReturnType<typeof prisma>) {
  requireCioProductionIdentity();
  db ||= prisma();
  const owner = randomUUID();
  if (!await acquireCioControl("seed", owner, db)) return { busy: true };
  try {
    return await db.$transaction(async tx => {
      const row = await tx.cioSyncControl.findUnique({ where: { id: "seed" } });
      const state = (row?.data || {}) as any;
      if (state.complete) return { complete: true, queued: 0 };
      const emails: { email: string }[] = await tx.$queryRawUnsafe(`
        SELECT email FROM (
          SELECT email_lower AS email FROM luma_event_guests UNION SELECT email_lower AS email FROM luma_people
        ) people WHERE email IS NOT NULL AND email > $1 ORDER BY email LIMIT $2`, state.cursor || "", Math.min(500, Math.max(1, limit)));
      // Prisma cannot deserialize PostgreSQL's void return type; cast the
      // side-effecting function's result while retaining the batch transaction.
      if (emails.length) await tx.$queryRawUnsafe(`SELECT cio_mark_email(email)::text AS queued FROM unnest($1::text[]) AS email`, emails.map(r => r.email));
      const next = { cursor: emails.at(-1)?.email || state.cursor || "", complete: emails.length < Math.min(500, Math.max(1, limit)) };
      await tx.cioSyncControl.update({ where: { id: "seed" }, data: { data: next, updatedAt: new Date() } });
      return { ...next, cursor: undefined, queued: emails.length };
    });
  } finally { await releaseCioControl("seed", owner, db); }
}

export async function acquireCioControl(id: string, owner: string, db = prisma()) {
  await db.cioSyncControl.upsert({ where: { id }, create: { id }, update: {} });
  const result = await db.cioSyncControl.updateMany({ where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { owner, leaseUntil: new Date(Date.now() + 120_000), updatedAt: new Date() } });
  return result.count === 1;
}
export async function releaseCioControl(id: string, owner: string, db = prisma()) {
  await db.cioSyncControl.updateMany({ where: { id, owner }, data: { owner: null, leaseUntil: null } });
}
export const privateCioReference = (email: string) => createHash("sha256").update(email).digest("hex").slice(0,12);

export async function cioSyncHealth(db = prisma()) {
  const [summary, source, delivery, seed] = await Promise.all([
    db.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS indexed,
      count(*) FILTER(WHERE revision > sent_revision)::int AS pending,
      count(*) FILTER(WHERE attempts >= 10)::int AS quarantined,
      count(*) FILTER(WHERE revision > sent_revision AND last_error = 'cio_profile_creation_disabled')::int AS held_new_profiles,
      count(*) FILTER(WHERE revision > sent_revision AND last_error = 'cio_profile_excluded')::int AS held_excluded_profiles,
      min(pending_since) FILTER(WHERE revision > sent_revision) AS oldest_pending_at,
      max(last_synced_at) AS last_success_at FROM cio_projection_queue`),
    db.cioSyncControl.findMany({ where: { id: { startsWith: "source:" } }, select: { id: true, data: true, updatedAt: true } }),
    db.cioSyncControl.findUnique({ where: { id: "delivery" }, select: { data: true } }),
    db.cioSyncControl.findUnique({ where: { id: "seed" }, select: { data: true } }),
  ]);
  return { ...summary[0], delivery: delivery?.data || {}, seedComplete: Boolean((seed?.data as any)?.complete),
    sources: source.map(s => { const d = s.data as any; return { source: s.id, lastCycleAt: d.lastCycleAt || null, lastError: d.lastError || null, updatedAt: s.updatedAt }; }) };
}
