import { Prisma } from "@prisma/client";

// Enable only after the reviewed migration has been applied. Existing reads stay
// compatible with the old schema while a deployment awaits migration approval.
export const emailRemovalEnabled = () => process.env.EMAIL_REMOVAL_ENABLED === "true";
export function activeEmailSql(email: Prisma.Sql) {
  return emailRemovalEnabled() ? Prisma.sql`NOT EXISTS (SELECT 1 FROM email_inactive i WHERE i."emailLower" = ${email})` : Prisma.sql`TRUE`;
}
export function activePersonSql(person: Prisma.Sql) {
  return emailRemovalEnabled() ? Prisma.sql`NOT EXISTS (SELECT 1 FROM guestbook_inactive_people ip WHERE ip.person_id = ${person})` : Prisma.sql`TRUE`;
}

// Same policy as guestbook_inactive_people, scoped before reading addresses.
// Duplicate addresses do not change whether the count of active addresses is zero.
export function inactivePeopleAmongCandidatesSql(candidates: Prisma.Sql) {
  return Prisma.sql`
    WITH candidate_addresses AS (
      SELECT person.person_id, LOWER(TRIM(COALESCE(person.email_lower, person.email))) AS email
      FROM luma_people AS person
      JOIN ${candidates} AS candidate ON candidate.person_id = person.person_id
      WHERE NULLIF(TRIM(COALESCE(person.email_lower, person.email)), '') IS NOT NULL
      UNION ALL
      SELECT guest.person_id, LOWER(TRIM(COALESCE(guest.email_lower, guest.email)))
      FROM luma_event_guests AS guest
      JOIN ${candidates} AS candidate ON candidate.person_id = guest.person_id
      WHERE NULLIF(TRIM(COALESCE(guest.email_lower, guest.email)), '') IS NOT NULL
      UNION ALL
      SELECT invitation."personId", LOWER(TRIM(invitation."emailLower"))
      FROM luma_invite_tracking AS invitation
      JOIN ${candidates} AS candidate ON candidate.person_id = invitation."personId"
      UNION ALL
      SELECT address."personId", LOWER(TRIM(address."emailLower"))
      FROM email_addresses AS address
      JOIN ${candidates} AS candidate ON candidate.person_id = address."personId"
    )
    SELECT address.person_id
    FROM candidate_addresses AS address
    LEFT JOIN email_inactive AS inactive ON inactive."emailLower" = address.email
    GROUP BY address.person_id
    HAVING COUNT(*) FILTER (WHERE inactive."emailLower" IS NULL) = 0
  `;
}
export async function removedEmails(emails: string[], db: any): Promise<Set<string>> {
  if (!emailRemovalEnabled() || !emails.length) return new Set();
  // Include partial removals: don't invite an address back while cleanup is incomplete.
  const rows = await db.$queryRaw(Prisma.sql`SELECT "emailLower" FROM email_inactive WHERE "emailLower" IN (${Prisma.join(emails)})
    UNION SELECT "emailLower" FROM email_removal_items WHERE status = 'succeeded' AND "emailLower" IN (${Prisma.join(emails)})`);
  return new Set(rows.map(r => r.emailLower));
}
