/** Count a shared event once while keeping all underlying registrations. */
export function aggregateMergedHistory<T extends { eventId: string; personId: string; status?: string; checkedInAt?: string | null }>(records: T[]): Array<T & { linkedRegistrations: T[] }> {
  const events = new Map<string, T & { linkedRegistrations: T[] }>();
  const rank = (r: T) => r.checkedInAt || r.status === "checked_in" ? 3 : ["going", "registered", "no_show"].includes(r.status || "") ? 2 : 1;
  for (const record of records) {
    const prior = events.get(record.eventId);
    const representative = !prior || rank(record) > rank(prior) ? record : prior;
    events.set(record.eventId, { ...representative, linkedRegistrations: [...(prior?.linkedRegistrations || []), record] });
  }
  return [...events.values()];
}
