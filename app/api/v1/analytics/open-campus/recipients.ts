import { isNewEventAttendee } from "../../../luma/new-event-attendee";
import { createHmac } from "node:crypto";
import type { FunnelEvent, FunnelGuest } from "../open-campus-funnel/cohort";

export type Recipient = { token: string; nameTokens?: string[]; receivedAt: string };
export function recipientToken(email: string, secret: string, nonce: string) {
  return createHmac("sha256", secret).update(`open-campus-recipient:v1:${nonce}:${email.trim().toLowerCase()}`).digest("hex");
}

export function recipientNameToken(name: string, secret: string, nonce: string) {
  const normalized = name.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized.includes("@") || normalized.split(" ").length < 2) return null;
  return createHmac("sha256", secret).update(`open-campus-recipient-name:v1:${nonce}:${normalized}`).digest("hex");
}

/** Exact email aliases stay inside Guestbook; private membership uses only request-local indices. */
export function evaluateRecipientMatches(events: FunnelEvent[], guests: FunnelGuest[], selected: string[], recipients: Recipient[], secret: string, nonce: string, now: Date, eligibleVisits?: Set<string>, requirePassAfterVisit = true) {
  const catalog = new Map(events.map(event => [event.eventId, event]));
  const selectedIds = new Set(selected);
  const parent = new Map<string, string>();
  function root(id: string): string {
    const path: string[] = [];
    let current = id;
    while (parent.has(current) && parent.get(current) !== current) {
      path.push(current); current = parent.get(current)!;
    }
    parent.set(current, current);
    for (const item of path) parent.set(item, current);
    return current;
  }
  for (const row of guests) if (row.emailLower?.trim()) parent.set(root(`e:${row.emailLower.trim().toLowerCase()}`), root(`p:${row.personId}`));
  const people = new Map<string, FunnelGuest[]>();
  for (const row of guests) { const id = root(`p:${row.personId}`); const rows = people.get(id) ?? []; rows.push(row); people.set(id, rows); }
  const byToken = new Map<string, string>();
  for (const row of guests) if (row.emailLower?.trim()) byToken.set(recipientToken(row.emailLower, secret, nonce), root(`p:${row.personId}`));
  const byName = new Map<string, Set<string>>();
  for (const row of guests) {
    const token = row.person?.name ? recipientNameToken(row.person.name, secret, nonce) : null;
    if (!token) continue;
    const ids = byName.get(token) ?? new Set<string>();
    ids.add(root(`p:${row.personId}`)); byName.set(token, ids);
  }
  const nameOwners = new Map<string, Set<number>>();
  recipients.forEach((recipient, index) => {
    for (const token of recipient.nameTokens ?? []) {
      const owners = nameOwners.get(token) ?? new Set<number>();
      owners.add(index); nameOwners.set(token, owners);
    }
  });
  const qualifyingVisits = (id: string, received: number) => people.get(id)!.filter(row =>
    (!eligibleVisits || eligibleVisits.has(`${row.eventId}\0${row.personId}`)) &&
    row.checkedInAt && row.checkedInAt <= now && catalog.has(row.eventId) &&
    selectedIds.has(row.eventId) && (!requirePassAfterVisit || row.checkedInAt.getTime() <= received));
  const resolved = recipients.map((recipient, recipientIndex) => {
    const received = Date.parse(recipient.receivedAt);
    const emailId = byToken.get(recipient.token);
    if (emailId && qualifyingVisits(emailId, received).length) return { id: emailId, recipientIndex, received, email: true };
    const candidates = new Set<string>();
    for (const token of recipient.nameTokens ?? []) {
      if (nameOwners.get(token)?.size !== 1) continue;
      for (const id of byName.get(token) ?? []) if (qualifyingVisits(id, received).length) candidates.add(id);
    }
    return { id: candidates.size === 1 ? [...candidates][0] : undefined, recipientIndex, received, email: false };
  }).sort((a, b) => Number(b.email) - Number(a.email));
  const matched = new Set<string>(), newcomers = new Set<string>();
  const recipientByPerson = new Map<string, number>();
  for (const { id, recipientIndex, received } of resolved) {
    if (!id || matched.has(id)) continue;
    const qualifying = qualifyingVisits(id, received);
    matched.add(id);
    if (!recipientByPerson.has(id)) recipientByPerson.set(id, recipientIndex);
    if (qualifying.some(row => isNewEventAttendee(row, people.get(id)!, catalog))) newcomers.add(id);
  }
  return { people: matched.size, newPeople: newcomers.size,
    matches: [...matched].map(id => ({ recipientIndex: recipientByPerson.get(id)!, isNew: newcomers.has(id) })) };
}

export function matchRecipients(...args: Parameters<typeof evaluateRecipientMatches>) {
  const { people, newPeople } = evaluateRecipientMatches(...args);
  return { people, newPeople };
}


export function isRecipientMatching(value: unknown, now: Date): value is { nonce: string; recipients: Recipient[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, any>;
  return !Object.keys(body).some(name => !["nonce", "recipients"].includes(name)) &&
    typeof body.nonce === "string" && /^[a-f0-9]{64}$/.test(body.nonce) &&
    Array.isArray(body.recipients) && body.recipients.length <= 1000 &&
    !body.recipients.some((r: any) => !r || typeof r !== "object" || Array.isArray(r) ||
      Object.keys(r).some(name => !["token", "nameTokens", "receivedAt"].includes(name)) ||
      (r.nameTokens !== undefined && (!Array.isArray(r.nameTokens) || r.nameTokens.length > 2 || r.nameTokens.some((token: unknown) => typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)))) ||
      typeof r.token !== "string" || !/^[a-f0-9]{64}$/.test(r.token) || typeof r.receivedAt !== "string" ||
      !Number.isFinite(Date.parse(r.receivedAt)) || new Date(r.receivedAt).toISOString() !== r.receivedAt || Date.parse(r.receivedAt) > now.getTime());
}
