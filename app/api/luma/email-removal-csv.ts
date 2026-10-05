import { Prisma } from "@prisma/client";

// Quote every field and neutralize spreadsheet formulas in user-controlled text.
function csvCell(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function removalCsv(id: string, db: any): Promise<string> {
  if (!id) throw Object.assign(new Error("Choose a removal job to download."), { status: 400, publicMessage: true });
  const jobs = await db.$queryRaw(Prisma.sql`SELECT id, calendars, "createdAt", "confirmedAt", "completedAt"
    FROM email_removal_jobs WHERE id=${id} AND status <> 'draft' LIMIT 1`);
  const job = jobs[0];
  if (!job) throw Object.assign(new Error("Removal job not found."), { status: 404, publicMessage: true });
  const rows = await db.$queryRaw(Prisma.sql`SELECT name, "emailLower", "calendarId", reason, status, error, "startedAt", "completedAt"
    FROM email_removal_items WHERE "jobId"=${id} ORDER BY "emailLower", "calendarId" LIMIT 50001`);
  if (rows.length > 50000) throw Object.assign(new Error("This removal job exceeds the CSV export limit."), { status: 413, publicMessage: true });
  const calendars = new Map<string, string>(job.calendars.map(c => [c.id, c.name]));
  const headers = ["Name", "Email", "Calendar", "Calendar ID", "Removal reason", "Status", "Error", "Started at (UTC)", "Completed at (UTC)", "Job ID", "Job created at (UTC)", "Job confirmed at (UTC)"];
  const data = rows.map(r => [r.name, r.emailLower, calendars.get(r.calendarId) || r.calendarId, r.calendarId,
    r.reason, r.status, r.error, r.startedAt, r.completedAt, job.id, job.createdAt, job.confirmedAt]);
  return "\uFEFF" + [headers, ...data].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
