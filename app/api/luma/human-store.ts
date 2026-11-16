import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { humanIdentityEnabled } from "./human-mode";
const error = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
export async function resolveHumanIds(
  db: any,
  ids: string[],
): Promise<string[]> {
  db = db.$source || db;
  if (!humanIdentityEnabled() || !ids.length) return [...new Set(ids)];
  const records = await db.$queryRaw(Prisma.sql`
    SELECT person_id AS id,COALESCE(merged_into_id,person_id) AS target FROM guestbook_people WHERE person_id IN (${Prisma.join(ids)})
    UNION SELECT account_id,person_id FROM guestbook_account_identities WHERE account_id IN (${Prisma.join(ids)})`);
  const map = new Map<string, string>(
    records.map((r: any) => [r.id, r.target]),
  );
  return [...new Set(ids.map((id) => map.get(id) || id))];
}
export async function sourceAccountsForHumans(
  db: any,
  ids: string[],
): Promise<string[]> {
  const humans = await resolveHumanIds(db, ids);
  const rows = await db.guestbookAccountIdentity.findMany({
    where: { personId: { in: humans } },
    select: { accountId: true },
  });
  return rows.map((r: any) => r.accountId);
}
export async function projectHumans(
  db: any,
  ids: string[],
  eventIds?: string[],
) {
  if (!ids.length) return;
  if (ids.length > 1000) throw error("Projection batch exceeds 1000.");
  // Void-returning functions must use executeRaw: Prisma cannot decode PG void.
  await db.$executeRaw`SELECT guestbook_project_humans(${ids}::text[],${eventIds || null}::text[])`;
}
export async function projectSourceAccounts(
  db: any,
  accountIds: string[],
  eventIds?: string[],
) {
  if (!humanIdentityEnabled() || !accountIds.length) return;
  db = db.$source || db;
  if (typeof db.$transaction === "function")
    return db.$transaction(
      (tx: any) => projectSourceAccounts(tx, accountIds, eventIds),
      { timeout: 30000 },
    );
  await db.$executeRaw`SELECT pg_advisory_xact_lock(821157031)`;
  const sorted = [...new Set(accountIds)].sort();
  for (const id of sorted)
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},821157032))`;
  const existing = await db.guestbookAccountIdentity.findMany({
    where: { accountId: { in: sorted } },
  });
  const known = new Set(existing.map((r: any) => r.accountId));
  for (const accountId of sorted.filter((id) => !known.has(id))) {
    const account = await db.lumaPerson.findUnique({
      where: { personId: accountId },
    });
    if (!account) throw error("Source account not found.", 404);
    const personId = "human_" + randomUUID();
    await db.guestbookPerson.create({
      data: { ...account, personId, primaryAccountId: accountId },
    });
    await db.guestbookAccountIdentity.create({ data: { accountId, personId } });
    existing.push({ accountId, personId });
  }
  await projectHumans(
    db,
    [...new Set<string>(existing.map((r: any) => r.personId))],
    eventIds,
  );
}
export async function humanAddresses(db: any, personId: string) {
  const ids = await resolveHumanIds(db, [personId]);
  return db.guestbookPersonEmail.findMany({
    where: { personId: { in: ids } },
    select: { emailLower: true },
  });
}
