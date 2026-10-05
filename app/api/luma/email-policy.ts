import { Prisma } from "@prisma/client";
import { prisma } from "./db";
export const VERIFICATION_MAX_AGE_MS = 30 * 86400000;
export function emailDecision(row: any, optedOut = false, now = Date.now()) {
  const reasons: string[] = [];
  if (row?.lumaBlockedReason) reasons.push(row.lumaBlockedReason === "reported" ? "Recorded Luma spam report" : row.lumaBlockedReason === "bounced" ? "Recorded Luma bounce" : "Luma reports an email restriction");
  if (optedOut) reasons.push("Opted out of this calendar");
  const fresh = row?.checkedAt && new Date(row.checkedAt).getTime() >= now - VERIFICATION_MAX_AGE_MS;
  if (fresh && row.state === "undeliverable") reasons.push("Emailable: undeliverable");
  if (reasons.length) return { status: "blocked", label: "Blocked", reason: reasons.join(" · ") };
  if (!fresh) return { status: "unchecked", label: "Not verified", reason: row?.checkedAt ? "Verification expired; sending allowed" : "Not checked; sending allowed" };
  if (row.state === "deliverable" && !row.flags?.acceptAll) return { status: "eligible", label: "Eligible", reason: "Recent deliverable result; delivery is not guaranteed" };
  return { status: "unconfirmed", label: "Unconfirmed", reason: "Mailbox not confirmed; sending allowed" };
}
// Historical evidence remains in invite tracking. A verified clear must not be undone by reading that same old timeline.
export async function recordLumaIssue(emailLower: string, reason: string, evidenceAt: Date | null, db = prisma()) {
  await db.$executeRaw(Prisma.sql`INSERT INTO email_addresses ("emailLower", "lumaBlockedReason", "lumaBlockedAt")
    VALUES (${emailLower}, ${reason}, ${evidenceAt || new Date()})
    ON CONFLICT ("emailLower") DO UPDATE SET
      "lumaBlockedReason" = CASE WHEN email_addresses."lumaBlockedReason" = 'reported' THEN 'reported' WHEN EXCLUDED."lumaBlockedReason" = 'restricted' THEN coalesce(email_addresses."lumaBlockedReason", 'restricted') ELSE EXCLUDED."lumaBlockedReason" END,
      "lumaBlockedAt" = GREATEST(email_addresses."lumaBlockedAt", EXCLUDED."lumaBlockedAt")
    WHERE email_addresses."lumaClearedAt" IS NULL OR (${evidenceAt}::timestamptz IS NOT NULL AND ${evidenceAt}::timestamptz > email_addresses."lumaClearedAt")`);
}
export function lumaIssueResult(value: any): boolean | null {
  if (value === true || value?.has_issue === true || value?.bounced_at || value?.marked_as_spam_at) return true;
  if (value === false || value?.has_issue === false) return false;
  return null;
}
