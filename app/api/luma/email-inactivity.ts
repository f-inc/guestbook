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
export async function removedEmails(emails: string[], db: any): Promise<Set<string>> {
  if (!emailRemovalEnabled() || !emails.length) return new Set();
  // Include partial removals: don't invite an address back while cleanup is incomplete.
  const rows = await db.$queryRaw(Prisma.sql`SELECT "emailLower" FROM email_inactive WHERE "emailLower" IN (${Prisma.join(emails)})
    UNION SELECT "emailLower" FROM email_removal_items WHERE status = 'succeeded' AND "emailLower" IN (${Prisma.join(emails)})`);
  return new Set(rows.map(r => r.emailLower));
}
