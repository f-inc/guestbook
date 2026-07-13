const timestampFieldsByStatus = {
  checked_in: ["checkedInAt", "updatedAt", "approvedAt", "registeredAt", "invitedAt", "createdAt"],
  invited: ["invitedAt", "createdAt", "updatedAt", "registeredAt"],
  going: ["approvedAt", "updatedAt", "registeredAt", "invitedAt", "createdAt"],
  registered: ["registeredAt", "createdAt", "updatedAt", "invitedAt"],
  waitlisted: ["updatedAt", "registeredAt", "createdAt", "invitedAt"],
  declined: ["updatedAt", "registeredAt", "createdAt", "invitedAt"],
  no_show: ["updatedAt", "registeredAt", "approvedAt", "createdAt", "invitedAt"],
};

const fallbackTimestampFields = ["updatedAt", "checkedInAt", "approvedAt", "registeredAt", "invitedAt", "createdAt"];

type GuestStatusRecord = Record<string, unknown> & { status?: string };
type EventDateRecord = {
  date?: unknown;
  startsAt?: unknown;
};

export function guestStatusDate(guest: GuestStatusRecord, event: EventDateRecord = {}): string | null {
  const fields = timestampFieldsByStatus[guest?.status] || fallbackTimestampFields;
  for (const field of fields) {
    const value = guest?.[field];
    if (validDateValue(value)) return String(value);
  }

  if (validDateValue(event?.startsAt)) return String(event.startsAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(event?.date || ""))) return `${event.date}T12:00:00`;
  if (validDateValue(event?.date)) return String(event.date);
  return null;
}

export function guestStatusTimestamp(guest: GuestStatusRecord, event: EventDateRecord = {}): number {
  const value = guestStatusDate(guest, event);
  return value ? new Date(value).getTime() : 0;
}

function validDateValue(value: unknown): boolean {
  return Boolean(value) && !Number.isNaN(new Date(String(value)).getTime());
}
