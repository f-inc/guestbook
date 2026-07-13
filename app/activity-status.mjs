export function activityRecordStatus(record, now = new Date()) {
  if (record.checkedInAt || record.status === "checked_in") return "checked_in";

  const isRegistered = Boolean(record.registeredAt || ["registered", "going", "no_show"].includes(record.status));
  if (isRegistered) return eventHasStarted(record, now) ? "no_show" : "registered";

  if (record.status === "invited" || record.invitedAt) return "invited";
  return record.status;
}

export function eventHasStarted(record, now = new Date()) {
  if (record.eventStartsAt) {
    const startsAt = new Date(record.eventStartsAt);
    if (!Number.isNaN(startsAt.getTime())) return startsAt <= now;
  }

  const eventDate = String(record.eventDate || "").slice(0, 10);
  return Boolean(eventDate) && eventDate < localDateKey(now);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
