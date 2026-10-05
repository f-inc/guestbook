import { inviteStatusLabels } from "../../invite-tracking";

// Read only cached invitation outcomes, never the broader email issue reason.
export async function withActivityInvitationStatuses(
  db: any,
  payload: any,
  personId?: string | null,
  email?: string | null,
) {
  const records = payload.records || [];
  const eventIds = [...new Set(records.map((record: any) => record.eventId))].slice(0, 5000);
  const emailLower = email?.trim().toLowerCase();
  const identity = emailLower
    ? { emailLower }
    : personId ? { OR: [{ personId }, { lumaUserId: personId }] } : null;
  if (!eventIds.length || !identity) return payload;
  const rows = await db.lumaInviteTracking.findMany({
    where: { eventId: { in: eventIds }, ...identity },
    select: { eventId: true, status: true },
    take: 5000,
  });
  const byEvent = new Map(rows.map((row: any) => [row.eventId, row.status]));
  return {
    ...payload,
    records: records.map((record: any) => {
      const status = byEvent.get(record.eventId) as string | undefined;
      return { ...record, invitationStatus: status && inviteStatusLabels[status] ? status : null };
    }),
  };
}
