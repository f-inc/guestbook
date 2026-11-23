import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRecipients, recipientToken, evaluateRecipientMatches, recipientNameToken } from "./analytics/open-campus/recipients";
import { openCampusAnalytics } from "./analytics/open-campus/handler";
const now = new Date("2026-11-22T12:00:00Z");
const secret = `gb_live_${"a".repeat(64)}`, nonce = "b".repeat(64);
const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, "0")}T12:00:00Z`);
const event = (eventId: string, title: string, day: number) => ({ eventId, title, startsAt: at(day), endsAt: at(day), location: null, category: null });
const guest = (personId: string, eventId: string, email: string, day: number) => ({ personId, eventId, emailLower: email, checkedInAt: at(day), registeredAt: at(day), approvedAt: at(day), status: "checked_in", hasPriorEvent: false });
const recipient = (email: string, day = 20) => ({ token: recipientToken(email, secret, nonce), receivedAt: at(day).toISOString() });
test("recipients are unique checked-in people, with first-visit newcomers nested inside", () => {
  const events = [event("old", "Community", 1), event("oc", "Open Campus", 10), event("oc2", "Open Campus", 15)];
  const guests = [guest("new", "oc", "new@example.test", 10), guest("new", "oc2", "alias@example.test", 15),
    guest("return", "old", "return@example.test", 1), guest("return", "oc", "return@example.test", 10),
    guest("unmatched", "oc", "unmatched@example.test", 10)];
  guests.find(row => row.personId === "new" && row.eventId === "oc2")!.hasPriorEvent = true;
  guests.find(row => row.personId === "return" && row.eventId === "oc")!.hasPriorEvent = true;
  const recipients = [recipient("new@example.test"), recipient("alias@example.test"), recipient("return@example.test"), recipient("absent@example.test")];
  assert.deepEqual(matchRecipients(events, guests, ["oc", "oc2"], recipients, secret, nonce, now), { people: 2, newPeople: 1 });
  assert.deepEqual(matchRecipients(events, guests, ["oc2"], recipients, secret, nonce, now), { people: 1, newPeople: 0 });
  assert.deepEqual(matchRecipients(events, guests, ["oc"], [recipient("new@example.test", 5)], secret, nonce, now), { people: 0, newPeople: 0 });
  assert.deepEqual(matchRecipients(events, guests, [], recipients, secret, nonce, now), { people: 0, newPeople: 0 });
  assert.equal(recipientToken(" New@Example.Test ", secret, nonce), recipientToken("new@example.test", secret, nonce));
  assert.notEqual(recipientToken("new@example.test", secret, nonce), recipientToken("new@example.test", secret, "c".repeat(64)));
});
test("unknown first-visit timestamps never imply a new face", () => {
  const events = [event("old", "Community", 1), event("oc", "Open Campus", 10)];
  events[0].startsAt = null as any;
  const guests = [guest("p", "old", "p@example.test", 1), guest("p", "oc", "p@example.test", 10)];
  guests[0].checkedInAt = null as any;
  delete (guests[1] as any).hasPriorEvent;
  assert.deepEqual(matchRecipients(events, guests, ["oc"], [recipient("p@example.test")], secret, nonce, now), { people: 1, newPeople: 0 });
});
test("POST authorizes before body/history and validates a bounded opaque payload", async () => {
  let historyReads = 0;
  const db: any = {
    integrationApiKey: { findUnique: async () => ({ scopes: ["events:read", "guests:read"], eventIds: ["oc"], revokedAt: null, expiresAt: null }) },
    lumaEvent: { findMany: async () => [{ ...event("oc", "Open Campus", 10), syncState: { lastGuestSyncAt: now, lastStatus: "success", truncated: false } }] },
    $queryRaw: async (sql: any) => sql.strings.join("").includes("attendee_tags") ? [] : [{ registered: 1, accepted: 1, checkedIn: 1, newRegistrations: 1, firstRegisters: 1, newFaces: 1 }],
    $transaction: async (callback: any) => { historyReads++; return callback({
      $executeRaw: async () => 0,
      lumaEvent: { findMany: async (query: any) => { assert.deepEqual(query.where.eventId.in, ["oc"]); return [event("oc", "Open Campus", 10)]; } },
      lumaEventGuest: { findMany: async () => [guest("p", "oc", "p@example.test", 10)] },
    }); },
  };
  const request = (body: unknown, auth = true) => new Request("https://guestbook.test/api/v1/analytics/open-campus", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await openCampusAnalytics(request({}, false), db, now)).status, 401);
  for (const body of [{}, { nonce, recipients: Array(1001).fill(recipient("p@example.test")) }, { nonce, recipients: [{ token: "p@example.test", receivedAt: now.toISOString() }] }, { nonce, recipients: [recipient("p@example.test", 25)] }, { nonce, recipients: [{ ...recipient("p@example.test"), nameTokens: ["Jordan Example"] }] }, { nonce, recipients: [{ ...recipient("p@example.test"), nameTokens: Array(3).fill("a".repeat(64)) }] }]) {
    assert.equal((await openCampusAnalytics(request(body), db, now)).status, 400);
  }
  assert.equal((await openCampusAnalytics(request({ nonce, recipients: [], padding: "x".repeat(131073) }), db, now)).status, 413);
  assert.equal(historyReads, 0);
  const response = await openCampusAnalytics(request({ nonce, recipients: [recipient("p@example.test")] }), db, now);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text).data.guestPassMatches, { people: 1, newPeople: 1, matches: [{ recipientIndex: 0, isNew: true }] });
  assert(!text.includes("example.test") && !text.includes(recipient("p@example.test").token));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});


test("a prior invitation or registration does not exclude a recipient from New", () => {
  const row = guest("p", "oc", "p@example.test", 10);
  row.hasPriorEvent = true;
  assert.deepEqual(matchRecipients([event("oc", "Open Campus", 10)], [row], ["oc"], [recipient("p@example.test")], secret, nonce, now), { people: 1, newPeople: 1 });
});


test("private recipient indices identify the exact deduplicated roster and New subset", () => {
  const events = [event("old", "Community", 1), event("oc", "Open Campus", 10)];
  const rows = [guest("new", "oc", "new@example.test", 10), guest("return", "oc", "return@example.test", 10), guest("return", "old", "return@example.test", 1)];
  rows[1].hasPriorEvent = true;
  const recipients = [recipient("missing@example.test"), recipient("new@example.test"), recipient("return@example.test"), recipient("new@example.test")];
  assert.deepEqual(evaluateRecipientMatches(events, rows, ["oc"], recipients, secret, nonce, now), { people: 2, newPeople: 1, matches: [{ recipientIndex: 1, isNew: true }, { recipientIndex: 2, isNew: false }] });
});


test("full-name fallback handles changed emails, preserves chronology and rejects ambiguity", () => {
  const events = [event("oc", "Open Campus", 10)];
  const row = { ...guest("p", "oc", "old@example.test", 10), person: { name: "  Jordan   Example " } };
  const token = recipientNameToken("JORDAN EXAMPLE", secret, nonce)!;
  const target = { ...recipient("changed@example.test"), nameTokens: [token] };
  assert.equal(token, recipientNameToken(row.person.name, secret, nonce));
  assert.equal(recipientNameToken("Jordan", secret, nonce), null);
  assert.equal(recipientNameToken("jordan@example.test", secret, nonce), null);
  assert.deepEqual(matchRecipients(events, [row], ["oc"], [target], secret, nonce, now), { people: 1, newPeople: 1 });
  assert.equal(matchRecipients(events, [row], ["oc"], [{ ...target, receivedAt: at(5).toISOString() }], secret, nonce, now).people, 0);
  const duplicate = { ...row, personId: "other", emailLower: "other@example.test" };
  assert.equal(matchRecipients(events, [row, duplicate], ["oc"], [target], secret, nonce, now).people, 0);
  assert.equal(matchRecipients(events, [row], ["oc"], [target, { ...target, token: recipient("second@example.test").token }], secret, nonce, now).people, 0);
  assert.deepEqual(evaluateRecipientMatches(events, [row], ["oc"], [target, recipient("old@example.test")], secret, nonce, now).matches, [{ recipientIndex: 1, isNew: true }]);
  const emptyEmailRecord = { ...row, personId: "empty", emailLower: "changed@example.test", checkedInAt: null as any };
  assert.equal(matchRecipients(events, [row, emptyEmailRecord], ["oc"], [target], secret, nonce, now).people, 1);
});
