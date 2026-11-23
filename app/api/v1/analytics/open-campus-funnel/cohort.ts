import { evaluateRecipientMatches, type Recipient } from "../open-campus/recipients";
import { GUEST_ACCEPTED_STATUSES, GUEST_REGISTERED_STATUSES } from "../../../luma/guest-query";

export type FunnelEvent = {
  eventId: string;
  title: string;
  location: string | null;
  category: string | null;
  date?: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
};
export type FunnelGuest = {
  person?: { name: string };
  hasPriorEvent?: boolean;
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
  matching?: { nonce: string; recipients: Recipient[]; secret: string },
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
  const eligibleVisits = new Set<string>();
  const counts: { firstVisit: number; registered: number; accepted: number; checkedIn: number; guestPass: number | null } = { firstVisit: 0, registered: 0, accepted: 0, checkedIn: 0, guestPass: null };
  let excludedMissingCheckInTime = 0,
    checkedInWithoutMatchableEmail = 0;
  const open = (event: FunnelEvent) => /\bopen\s+campus\b/i.test(event.title);
  for (const rows of people.values()) {
    const matchesEventFilters = (event: FunnelEvent) => {
      const status = !event.startsAt || event.startsAt <= now
        ? !event.endsAt || !event.startsAt || event.endsAt <= event.startsAt
          ? "unknown" : event.endsAt <= now ? "held" : "ongoing"
        : "upcoming";
      return !open(event) &&
        (!query.category || (event.category || "Other events") === query.category) &&
        (query.location === undefined || (event.location || "").trim() === query.location) &&
        (!query.status || status === query.status);
    };
    // Any recorded visit in this period qualifies, including returning visitors.
    const visits = rows.filter(row => {
      const event = catalog.get(row.eventId);
      if (!event || !matchesEventFilters(event) || !row.checkedInAt || row.checkedInAt > now) return false;
      const day = pacificDay.format(row.checkedInAt);
      return day >= query.from && day < query.to;
    }).sort((a, b) => a.checkedInAt!.getTime() - b.checkedInAt!.getTime());
    const first = visits[0];
    if (!first) {
      if (rows.some(row => {
        const event = catalog.get(row.eventId);
        if (row.status !== "checked_in" || row.checkedInAt || !event?.startsAt || !matchesEventFilters(event)) return false;
        const day = pacificDay.format(event.startsAt);
        return day >= query.from && day < query.to;
      })) excludedMissingCheckInTime++;
      continue;
    }
    counts.firstVisit++;
    members.firstVisit.push({ personId: first.personId, eventId: first.eventId });
    const registrations = rows.filter(row => {
      const event = catalog.get(row.eventId);
      if (!event || !open(event)) return false;
      const laterCheckIn = !!row.checkedInAt && row.checkedInAt > first.checkedInAt! && row.checkedInAt <= now;
      const laterEvent = event.startsAt
        ? event.startsAt > first.checkedInAt!
        : !!row.registeredAt && row.registeredAt > first.checkedInAt! && row.registeredAt <= now;
      // Advance registration/approval is valid for a later Open Campus event.
      return (laterCheckIn || laterEvent) && (
        laterCheckIn || (row.registeredAt ? row.registeredAt <= now :
        GUEST_REGISTERED_STATUSES.includes(row.status ?? "") ||
        (!!row.approvedAt && row.approvedAt <= now)));
    });
    if (!registrations.length) continue;
    counts.registered++;
    members.registered.push({ personId: first.personId, eventId: registrations[0].eventId });
    const accepted = registrations.filter(
      (row) =>
        (GUEST_ACCEPTED_STATUSES.includes(row.status ?? "") ||
          row.checkedInAt !== null ||
          (!!row.approvedAt && row.approvedAt <= now)),
    );
    if (!accepted.length) continue;
    counts.accepted++;
    members.accepted.push({ personId: first.personId, eventId: accepted[0].eventId });
    const checked = accepted.filter(
      (row) =>
        row.checkedInAt &&
        row.checkedInAt > first.checkedInAt! &&
        row.checkedInAt <= now,
    );
    if (!checked.length) continue;
    for (const row of checked) eligibleVisits.add(`${row.eventId}\0${row.personId}`);
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
  if (matching && query.from >= "2026-09-20") {
    counts.guestPass = evaluateRecipientMatches(events, guests,
      events.filter(open).map(event => event.eventId), matching.recipients, matching.secret,
      matching.nonce, now, eligibleVisits, false).people;
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
  matching?: { nonce: string; recipients: Recipient[]; secret: string },
) {
  return evaluateOpenCampusFunnel(events, guests, query, now, matching).counts;
}
