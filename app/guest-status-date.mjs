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

export function guestStatusDate(guest, event = {}) {
  const fields = timestampFieldsByStatus[guest?.status] || fallbackTimestampFields;
  for (const field of fields) {
    if (validDateValue(guest?.[field])) return guest[field];
  }

  if (validDateValue(event?.startsAt)) return event.startsAt;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(event?.date || ""))) return `${event.date}T12:00:00`;
  if (validDateValue(event?.date)) return event.date;
  return null;
}

export function guestStatusTimestamp(guest, event = {}) {
  const value = guestStatusDate(guest, event);
  return value ? new Date(value).getTime() : 0;
}

function validDateValue(value) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}
