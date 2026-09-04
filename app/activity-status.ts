import { guestStatusAfterEvent } from "./guest-display-status";

type ActivityRecord = {
  approvedAt?: unknown;
  checkedInAt?: unknown;
  eventDate?: unknown;
  eventEndsAt?: unknown;
  eventStartsAt?: unknown;
  eventCancelled?: unknown;
  eventCatalogActive?: unknown;
  invitedAt?: unknown;
  lumaApprovalStatus?: unknown;
  registeredAt?: unknown;
  status?: string;
};

export function activityRecordStatus(record: ActivityRecord, now = new Date()): string | undefined {
  if (record.checkedInAt || record.status === "checked_in") return "checked_in";
  if (eventWasCancelledOrDeleted(record)) return "cancelled";

  const isRegistered = Boolean(record.registeredAt || ["registered", "going", "no_show"].includes(record.status));
  if (isRegistered) {
    const approved = record.lumaApprovalStatus === "approved"
      || Boolean(record.approvedAt)
      || record.status === "going";
    return approved
      ? guestStatusAfterEvent(
          { ...record, status: "going" },
          { endsAt: record.eventEndsAt, cancelled: record.eventCancelled === true, catalogActive: record.eventCatalogActive !== false },
          now,
        )
      : "registered";
  }

  if (record.status === "invited" || record.invitedAt) return "invited";
  return record.status;
}

export function eventWasCancelledOrDeleted(record: ActivityRecord): boolean {
  return record.eventCancelled === true || record.eventCatalogActive === false;
}

export function eventHasStarted(record: ActivityRecord, now = new Date()): boolean {
  if (record.eventStartsAt) {
    const startsAt = new Date(String(record.eventStartsAt));
    if (!Number.isNaN(startsAt.getTime())) return startsAt <= now;
  }

  const eventDate = String(record.eventDate || "").slice(0, 10);
  return Boolean(eventDate) && eventDate < localDateKey(now);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
