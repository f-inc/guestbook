type GuestStatusRecord = {
  checkedInAt?: unknown;
  lumaApprovalStatus?: unknown;
  status?: string | null;
};

type GuestStatusEvent = {
  cancelled?: boolean;
  catalogActive?: boolean;
  endsAt?: unknown;
};

export function storedGuestStatus(record: GuestStatusRecord): string {
  if (record.checkedInAt || record.status === "checked_in") return "checked_in";
  if (record.status === "no_show" && record.lumaApprovalStatus === "approved") return "going";
  return record.status || "registered";
}

export function guestStatusAfterEvent(
  record: GuestStatusRecord,
  event: GuestStatusEvent = {},
  now = new Date(),
): string {
  const status = storedGuestStatus(record);
  if (status !== "going" || event.cancelled === true || event.catalogActive === false) return status;
  const endsAt = new Date(String(event.endsAt || "")).getTime();
  return Number.isFinite(endsAt) && endsAt <= now.getTime() ? "no_show" : status;
}
