import {
  mergeInvitationMessages,
  invitationMessages,
} from "../../invite-tracking";

export function timelineIssues(payload: any) {
  const entries = Array.isArray(payload) ? payload : payload?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e?.type === "email-sent" && e.email?.api_id)
    .flatMap((e) =>
      invitationMessages([
        {
          ...e,
          email: { ...e.email, email_type: "to-guest--event-invitation" },
        },
      ]).map((m) => ({
        ...m,
        emailType: e.email.email_type,
        subject: e.email.subject || null,
      })),
    )
    .filter((m) => m.status === "bounced" || m.status === "reported");
}
export function issueEvidence(rows: any[]) {
  const messages = mergeInvitationMessages(
    [],
    rows.flatMap((r) => [
      ...(Array.isArray(r.messages) ? r.messages : []),
      ...(Array.isArray(r.issueMessages) ? r.issueMessages : []),
    ]),
  );
  const failures = messages.filter(
    (m) =>
      m.bouncedAt || m.reportedAt || ["bounced", "reported"].includes(m.status),
  );
  return {
    bouncedCount: failures.filter((m) => m.bouncedAt || m.status === "bounced")
      .length,
    reportedCount: failures.filter(
      (m) => m.reportedAt || m.status === "reported",
    ).length,
    lastFailureAt:
      failures
        .flatMap((m) => [m.bouncedAt, m.reportedAt])
        .filter(Boolean)
        .sort()
        .at(-1) || null,
  };
}

export async function groupedEmailIssues(
  database: any,
  query: string,
  offset: number,
) {
  const where: any = {
    issueReason: { not: null },
    ...(query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { emailLower: { contains: query.toLowerCase() } },
          ],
        }
      : {}),
  };
  const groups = await database.lumaInviteTracking.groupBy({
    by: ["emailLower"],
    where,
    _max: { updatedAt: true },
    orderBy: [{ _max: { updatedAt: "desc" } }, { emailLower: "asc" }],
    take: 51,
    skip: offset,
  });
  const emails = groups.slice(0, 50).map((g) => g.emailLower);
  const records = await database.lumaInviteTracking.findMany({
    where: { emailLower: { in: emails }, issueReason: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: 5000,
  });
  return {
    rows: emails.map((emailLower) => {
      const sources = records.filter((r) => r.emailLower === emailLower);
      const first = sources[0];
      return {
        ...first,
        emailLower,
        messages: undefined,
        issueMessages: undefined,
        ...issueEvidence(sources),
        eventCount: sources.length,
        sources: sources.map(
          ({ eventId, emailLower, eventTitle, removedAt }) => ({
            eventId,
            emailLower,
            eventTitle,
            removedAt,
          }),
        ),
        removedAt: sources.every((r) => r.removedAt) ? first?.removedAt : null,
      };
    }),
    hasMore: groups.length > 50,
    nextOffset: offset + emails.length,
    historyTruncated: records.length === 5000,
  };
}
