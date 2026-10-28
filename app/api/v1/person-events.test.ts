import assert from "node:assert/strict";
import { test } from "node:test";
import { personEvents } from "./people/[personId]/events/handler";
import { generateKey } from "./shared";

const secret = generateKey().secret;
const baseKey = { id: "key", scopes: ["events:read", "guests:read"], eventIds: [], revokedAt: null, expiresAt: null };
const request = (query = "", auth = true) => new Request(`https://guestbook.test/api/v1/people/usr-one/events${query}`, {
  headers: auth ? { Authorization: `Bearer ${secret}` } : {},
});
function setup(key: any = baseKey) {
  const calls: any[] = [];
  const makeEvent = (eventId: string) => ({
    eventId, title: `Event ${eventId}`, startsAt: "2026-10-28T12:00:00Z", catalogActive: true,
    guests: [{
      personId: "internal@example.test", lumaUserId: "usr-one", lumaGuestId: `guest-${eventId}`,
      status: eventId === "a" ? "waitlisted" : "no_show", lumaApprovalStatus: "waitlist", operatorDecision: "approved",
      registeredAt: "2026-10-20T12:00:00Z", invitedAt: null, approvedAt: null, checkedInAt: null,
      updatedAt: "2026-10-27T12:00:00Z", syncedAt: "2026-10-27T15:00:00Z",
      person: { name: "Guest One", lumaUserId: "usr-one" },
    }],
  });
  const db = {
    integrationApiKey: { findUnique: async () => key },
    lumaEventGuest: { findFirst: async (query: any) => { calls.push({ identityLookup: query }); return { personId: "internal@example.test", lumaUserId: "usr-one" }; } },
    lumaEvent: { findMany: async (query: any) => { calls.push(query); return Array.from({ length: 11 }, (_, i) => makeEvent(String.fromCharCode(97 + i))); } },
  };
  return { db, calls, makeEvent };
}
test("history reads ten events from the index without network calls or dependence on Luma", async t => {
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw Error("Luma is offline"); });
  const ctx = setup();
  const response = await personEvents(request(), "usr-one", ctx.db);
  assert.equal(response.status, 200);
  assert.equal(networkCalls, 0);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result: any = await response.json();
  assert.deepEqual(result.data.map((record: any) => record.event.eventId), ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  assert.deepEqual(result.pagination, { hasMore: true, nextCursor: "j" });
  assert.equal(result.data[0].status, "waitlisted");
  assert.equal(result.data[1].status, "no_show");
  assert.equal(result.data[0].operatorDecision, "approved");
  assert.equal(result.data[0].syncedAt, "2026-10-27T15:00:00Z");
  assert.equal(result.data[0].fetchedAt, undefined);
  assert.equal(result.data[0].personId, "usr-one");
  assert.equal(result.data[0].name, "Guest One");
  assert.equal(result.data[0].email, undefined);
  assert.equal(result.data[0].person, undefined);
  assert.equal(result.data[0].event.guests, undefined);
  assert.equal(result.source, "luma-index");
  assert.equal(result.coverage, "indexed-person-events");
  assert.equal(result.scannedEventCount, 10);
  assert.match(result.requestId, /^integration-/);
  assert.equal(JSON.stringify(result).includes("internal@example.test"), false);
  assert.equal(ctx.calls[0].take, 11);
  assert.deepEqual(ctx.calls[0].where.guests.some, { OR: [{ personId: "usr-one" }, { lumaUserIdLower: "usr-one" }] });
  assert.deepEqual(ctx.calls[0].select.guests.orderBy, [{ syncedAt: "desc" }, { personId: "asc" }]);
  assert.equal(ctx.calls[0].select.guests.take, 1);
});
test("history event restrictions and continuation cursors are enforced in the database query", async () => {
  const ctx = setup({ ...baseKey, eventIds: ["b", "c"] });
  ctx.db.lumaEvent.findMany = async query => { ctx.calls.push(query); return [ctx.makeEvent("b"), ctx.makeEvent("c")]; };
  const result: any = await (await personEvents(request("?limit=1&cursor=a"), "usr-one", ctx.db)).json();
  assert.deepEqual(ctx.calls[0].where.eventId, { in: ["b", "c"], gt: "a" });
  assert.deepEqual(result.pagination, { hasMore: true, nextCursor: "b" });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].event.eventId, "b");
  assert.equal(ctx.calls[0].select.guests.select.email, undefined);
  assert.equal(ctx.calls[0].select.guests.select.person.select.email, undefined);
  assert.equal(ctx.calls[0].select.guests.select.raw, undefined);
});
test("email permission allows the stored event email and a stored person-email fallback", async () => {
  const ctx = setup({ ...baseKey, scopes: [...baseKey.scopes, "guests:email"] });
  ctx.db.lumaEvent.findMany = async query => {
    ctx.calls.push(query);
    return ["a", "b"].map(id => {
      const row: any = ctx.makeEvent(id);
      row.guests[0].email = id === "a" ? "event@example.test" : null;
      row.guests[0].person.email = "person@example.test";
      return row;
    });
  };
  const result: any = await (await personEvents(request(), "usr-one", ctx.db)).json();
  assert.equal(result.data[0].email, "event@example.test");
  assert.equal(result.data[1].email, "person@example.test");
  assert.equal(ctx.calls[0].select.guests.select.email, true);
  assert.equal(ctx.calls[0].select.guests.select.person.select.email, true);
});
test("guest-only IDs resolve to linked indexed memberships without leaking internal email-based IDs or names", async () => {
  const ctx = setup();
  ctx.db.lumaEvent.findMany = async query => {
    ctx.calls.push(query);
    const row = ctx.makeEvent("a");
    row.guests[0].lumaUserId = null;
    row.guests[0].person.lumaUserId = null;
    row.guests[0].person.name = "internal@example.test";
    return [row];
  };
  const result: any = await (await personEvents(request(), "guest:guest-a", ctx.db)).json();
  assert.deepEqual(ctx.calls[0].identityLookup.where, { lumaGuestId: "guest-a" });
  assert.deepEqual(ctx.calls[1].where.guests.some, { OR: [{ personId: "internal@example.test" }, { lumaUserIdLower: "usr-one" }] });
  assert.equal(result.data[0].personId, "guest:guest-a");
  assert.equal(result.data[0].name, "Unnamed guest");
  assert.equal(JSON.stringify(result).includes("internal@example.test"), false);
});
test("unknown and inaccessible people return empty indexed history without revealing existence elsewhere", async () => {
  const ctx = setup({ ...baseKey, eventIds: ["allowed-only"] });
  ctx.db.lumaEvent.findMany = async query => { ctx.calls.push(query); return []; };
  const response = await personEvents(request(), "usr-unknown", ctx.db);
  assert.equal(response.status, 200);
  const result: any = await response.json();
  assert.deepEqual(result.data, []);
  assert.deepEqual(result.pagination, { hasMore: false, nextCursor: null });
  assert.equal(result.source, "luma-index");
});
test("missing, expired, revoked, or under-scoped credentials fail before history lookup", async () => {
  for (const key of [null, { ...baseKey, revokedAt: new Date() }, { ...baseKey, expiresAt: new Date(0) }, { ...baseKey, scopes: ["guests:read"] }, { ...baseKey, scopes: ["events:read"] }]) {
    const ctx = setup(key);
    const response = await personEvents(request(), "usr-one", ctx.db);
    assert.equal(response.status, key?.scopes.length === 1 ? 403 : 401);
    assert.deepEqual(ctx.calls, []);
  }
  const ctx = setup();
  assert.equal((await personEvents(request("", false), "usr-one", ctx.db)).status, 401);
  assert.deepEqual(ctx.calls, []);
});
test("history rejects malformed IDs, repeated queries, and limits outside the standard API range", async () => {
  for (const [id, query] of [["", ""], ["private@example.test", ""], ["../usr-one", ""], ["usr-one", "?limit=501"], ["usr-one", "?limit=0"], ["usr-one", "?limit=1&limit=2"], ["usr-one", "?email=private@example.test"], ["usr-one", "?cursor="], ["usr-one", "?refresh=true"]]) {
    const ctx = setup();
    assert.equal((await personEvents(request(query), id, ctx.db)).status, 400);
    assert.deepEqual(ctx.calls, []);
  }
  const ctx = setup();
  assert.equal((await personEvents(request("?limit=25"), "usr-one", ctx.db)).status, 200);
  assert.equal(ctx.calls[0].take, 26);
});
test("stored check-in evidence takes precedence without inferring other statuses", async () => {
  const ctx = setup();
  ctx.db.lumaEvent.findMany = async () => {
    const row = ctx.makeEvent("a");
    row.guests[0].checkedInAt = "2026-10-27T16:00:00Z";
    return [row];
  };
  const result: any = await (await personEvents(request(), "usr-one", ctx.db)).json();
  assert.equal(result.data[0].status, "checked_in");
  assert.equal(result.data[0].checkedIn, true);
});
test("membership changes during a query do not break pagination", async () => {
  const ctx = setup();
  ctx.db.lumaEvent.findMany = async () => {
    const row = ctx.makeEvent("a");
    row.guests = [];
    return [row, ctx.makeEvent("b")];
  };
  const result: any = await (await personEvents(request("?limit=1"), "usr-one", ctx.db)).json();
  assert.deepEqual(result.data, []);
  assert.deepEqual(result.pagination, { hasMore: true, nextCursor: "a" });
});
test("database errors are sanitized and do not return partial history", async () => {
  const ctx = setup();
  ctx.db.lumaEvent.findMany = async () => { throw new Error("private connection credentials"); };
  const response = await personEvents(request(), "usr-one", ctx.db);
  assert.equal(response.status, 500);
  const result: any = await response.json();
  assert.equal(result.data, undefined);
  assert.equal(result.error.includes("private connection credentials"), false);
  assert.match(result.requestId, /^integration-/);
});
test("guest-only identity resolution is event-scoped and does not reveal inaccessible IDs", async () => {
  const ctx = setup({ ...baseKey, eventIds: ["a"] });
  ctx.db.lumaEventGuest.findFirst = async query => { ctx.calls.push({ identityLookup: query }); return null; };
  const result: any = await (await personEvents(request(), "guest:hidden", ctx.db)).json();
  assert.deepEqual(ctx.calls[0].identityLookup.where, { lumaGuestId: "hidden", eventId: { in: ["a"] } });
  assert.deepEqual(result.data, []);
  assert.equal(result.source, "luma-index");
  assert.equal(ctx.calls.length, 1);
});
