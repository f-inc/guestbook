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
export function evaluateRecipientMatches(events: FunnelEvent[], guests: FunnelGuest[], selected: string[], recipients: Recipient[], secret: string, nonce: string, now: Date) {
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
    row.checkedInAt && row.checkedInAt <= now && catalog.has(row.eventId) &&
    selectedIds.has(row.eventId) && row.checkedInAt.getTime() <= received);
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
  const uncertainPeople = new Set<string>();
  let uncertain = false;
  for (const { id, recipientIndex, received } of resolved) {
    if (!id || matched.has(id)) continue;
    const qualifying = qualifyingVisits(id, received);
    matched.add(id);
    if (!recipientByPerson.has(id)) recipientByPerson.set(id, recipientIndex);
    // Reuse the native Guestbook newcomer flag; invitations/registrations are history too.
    if (qualifying.some(row => row.hasPriorEvent === false)) newcomers.add(id);
    else if (qualifying.some(row => row.hasPriorEvent === undefined)) { uncertain = true; uncertainPeople.add(id); }
  }
  return { people: matched.size, newPeople: uncertain ? null : newcomers.size,
    matches: [...matched].map(id => ({ recipientIndex: recipientByPerson.get(id)!, isNew: newcomers.has(id) ? true : uncertainPeople.has(id) ? null : false })) };
}

export function matchRecipients(...args: Parameters<typeof evaluateRecipientMatches>) {
  const { people, newPeople } = evaluateRecipientMatches(...args);
  return { people, newPeople };
}
