import { GUEST_ACCEPTED_STATUSES } from "../../../luma/guest-query";

export type FunnelEvent = {
  eventId: string;
  title: string;
  location: string | null;
  category: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};
export type FunnelGuest = {
  eventId: string;
  personId: string;
  emailLower: string | null;
  registeredAt: Date | null;
  approvedAt: Date | null;
  checkedInAt: Date | null;
  status: string | null;
};
export type FunnelQuery = {
  from: string;
  to: string;
  category?: string;
  location?: string;
  status?: string;
};
const pacificDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** Counts one connected indexed person/email identity once. Raw identities never leave Guestbook. */
export function evaluateOpenCampusFunnel(
  events: FunnelEvent[],
  guests: FunnelGuest[],
  query: FunnelQuery,
  now = new Date(),
) {
  const catalog = new Map(events.map((event) => [event.eventId, event]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const next = parent.get(id);
    if (!next) {
      parent.set(id, id);
      return id;
    }
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  for (const guest of guests) {
    const person = find(`p:${guest.personId}`);
    if (guest.emailLower?.trim())
      parent.set(find(`e:${guest.emailLower.trim().toLowerCase()}`), person);
  }
  const people = new Map<string, FunnelGuest[]>();
  for (const guest of guests) {
    const id = find(`p:${guest.personId}`);
    const rows = people.get(id) ?? [];
    rows.push(guest);
    people.set(id, rows);
  }
  const members: Record<string, { personId: string; eventId: string }[]> = {
    firstVisit: [],
    registered: [],
    accepted: [],
    checkedIn: [],
  };
  const counts = { firstVisit: 0, registered: 0, accepted: 0, checkedIn: 0, guestPass: null };
  let excludedMissingCheckInTime = 0,
    checkedInWithoutMatchableEmail = 0;
  const open = (event: FunnelEvent) => /\bopen\s+campus\b/i.test(event.title);
  for (const rows of people.values()) {
    // A status-only earlier visit cannot establish a first-visit date. Do not guess it.
    if (rows.some((row) => row.status === "checked_in" && !row.checkedInAt)) {
      excludedMissingCheckInTime++;
      continue;
    }
    const visits = rows
      .filter((row) => row.checkedInAt && row.checkedInAt <= now && catalog.has(row.eventId))
      .sort((a, b) => a.checkedInAt!.getTime() - b.checkedInAt!.getTime());
    const first = visits[0];
    if (!first) continue;
    const event = catalog.get(first.eventId)!;
    if (
      open(event) ||
      visits.some(
        (row) =>
          row.checkedInAt!.getTime() === first.checkedInAt!.getTime() &&
          open(catalog.get(row.eventId)!),
      )
    )
      continue;
    const day = pacificDay.format(first.checkedInAt!);
    const status =
      !event.startsAt || event.startsAt <= now
        ? !event.endsAt || !event.startsAt || event.endsAt <= event.startsAt
          ? "unknown"
          : event.endsAt <= now
            ? "held"
            : "ongoing"
        : "upcoming";
    if (
      day < query.from ||
      day >= query.to ||
      (query.category && (event.category || "Other events") !== query.category) ||
      (query.location !== undefined && (event.location || "").trim() !== query.location) ||
      (query.status && status !== query.status)
    )
      continue;
    counts.firstVisit++;
    members.firstVisit.push({ personId: first.personId, eventId: first.eventId });
    const registrations = rows.filter(
      (row) =>
        catalog.has(row.eventId) &&
        open(catalog.get(row.eventId)!) &&
        row.registeredAt &&
        row.registeredAt > first.checkedInAt! &&
        row.registeredAt <= now,
    );
    if (!registrations.length) continue;
    counts.registered++;
    members.registered.push({ personId: first.personId, eventId: registrations[0].eventId });
    const accepted = registrations.filter(
      (row) =>
        (GUEST_ACCEPTED_STATUSES.includes(row.status ?? "") ||
          row.checkedInAt !== null ||
          row.approvedAt !== null) &&
        (!row.approvedAt || (row.approvedAt >= row.registeredAt! && row.approvedAt <= now)),
    );
    if (!accepted.length) continue;
    counts.accepted++;
    members.accepted.push({ personId: first.personId, eventId: accepted[0].eventId });
    const checked = accepted.filter(
      (row) =>
        row.checkedInAt &&
        row.checkedInAt >= row.registeredAt! &&
        row.checkedInAt <= now &&
        (!row.approvedAt || row.checkedInAt >= row.approvedAt),
    );
    if (!checked.length) continue;
    counts.checkedIn++;
    members.checkedIn.push({ personId: first.personId, eventId: checked[0].eventId });
    const emails = [
      ...new Set(
        rows
          .map((row) => row.emailLower?.trim().toLowerCase())
          .filter((value): value is string => !!value),
      ),
    ];
    if (!emails.length) checkedInWithoutMatchableEmail++;
  }
  return {
    counts: { ...counts, excludedMissingCheckInTime, checkedInWithoutMatchableEmail },
    members,
  };
}

// Aggregate API callers never receive membership identities.
export function buildOpenCampusFunnel(
  events: FunnelEvent[],
  guests: FunnelGuest[],
  query: FunnelQuery,
  now = new Date(),
) {
  return evaluateOpenCampusFunnel(events, guests, query, now).counts;
}
