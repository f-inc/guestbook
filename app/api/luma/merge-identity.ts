import { humanIdentityEnabled } from "./human-mode";
import { resolveHumanIds } from "./human-store";
import { Prisma } from "@prisma/client";

type Reader = { $queryRaw: any };
export type Membership = { personId: string; canonicalId: string };
export async function mergesReady(db: Reader): Promise<boolean> {
  const rows = await db.$queryRaw`SELECT to_regclass('person_merge_members') IS NOT NULL AND to_regclass('person_merge_operations') IS NOT NULL AS ready`;
  return Boolean(rows[0]?.ready);
}
export async function linkedPersonIds(db: Reader, ids: string[]): Promise<string[]> {
  if (humanIdentityEnabled()) return resolveHumanIds(db, ids);
  if (!ids.length || !await mergesReady(db)) return ids;
  const rows: Membership[] = await db.$queryRaw(Prisma.sql`
    SELECT person_id AS "personId", canonical_id AS "canonicalId" FROM person_merge_members
    WHERE canonical_id IN (
      SELECT canonical_id FROM person_merge_members WHERE person_id IN (${Prisma.join(ids)})
    ) OR person_id IN (${Prisma.join(ids)})
  `);
  return [...new Set([...rows.map(row => row.canonicalId), ...ids, ...rows.map(row => row.personId)])];
}

/** Join each requested account to all linked accounts for distinct-event counts. */
export async function mergedHistoryJoin(db: Reader, ids: string[]) {
  if (humanIdentityEnabled() || !await mergesReady(db)) return Prisma.sql`JOIN unnest(${ids}::text[]) AS identity(requested_id) ON identity.requested_id = guest.person_id`;
  return Prisma.sql`JOIN (
    SELECT requested.person_id AS requested_id, COALESCE(member.person_id, requested.person_id) AS source_id
    FROM unnest(${ids}::text[]) AS requested(person_id)
    LEFT JOIN person_merge_members AS target ON target.person_id = requested.person_id
    LEFT JOIN person_merge_members AS member ON member.canonical_id = target.canonical_id
  ) AS identity ON identity.source_id = guest.person_id`;
}
