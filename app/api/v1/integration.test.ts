import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLiveGuest } from "./live-guests";
import { authorize, generateKey, hashKey } from "./shared";
import { events } from "./events/handler";
import { guests } from "./events/[eventId]/guests/handler";
import { GET as listKeys, POST as createKey, DELETE as revokeKey } from "../admin/api-keys/route";
const token = generateKey();
const baseKey = { id: "key", scopes: ["events:read", "guests:read"], eventIds: [], revokedAt: null, expiresAt: null };
const request = (path = "/events", auth = true) => new Request(`https://guestbook.test/api/v1${path}`, { headers: auth ? { Authorization: `Bearer ${token.secret}` } : {} });
function mockDb(key = { ...baseKey }) {
  const calls: any[] = [];
  return {
    calls,
    integrationApiKey: { findUnique: async (args: any) => { calls.push(args); return key; } },
    lumaEvent: {
      findUnique: async () => ({ eventId: "evt", syncedAt: new Date(), syncState: { truncated: true, lastGuestSyncAt: null } }),
      findMany: async (args: any) => { calls.push(args); return [{ eventId: "a" }, { eventId: "b" }]; },
    },
    lumaEventGuest: { findMany: async (args: any) => {
      calls.push(args);
      return [{ personId: "a", status: "checked_in", checkedInAt: null, person: { name: "Guest", email: "private@example.test" }, email: "event@example.test" }];
    } },
  };
}
test("integration auth rejects missing, shared-login, revoked, expired, and under-scoped keys", async () => {
  assert.notEqual(generateKey().secret, token.secret);
  assert.equal(hashKey(token.secret), token.keyHash);
  assert.ok(!token.keyHash.includes(token.secret));
  for (const req of [request("/events", false), new Request("https://test", { headers: { cookie: "guestbook_key=shared", "x-guestbook-key": "shared" } })]) {
    const db = mockDb();
    await assert.rejects(authorize(req, "events:read", db), { status: 401 });
    assert.equal(db.calls.length, 0);
  }
  for (const key of [null, { ...baseKey, revokedAt: new Date() }, { ...baseKey, expiresAt: new Date(0) }, { ...baseKey, scopes: [] }]) {
    await assert.rejects(authorize(request(), "events:read", mockDb(key)), { status: key?.scopes.length === 0 ? 403 : 401 });
  }
});
test("events enforce event restrictions and bounded deterministic pagination", async () => {
  const db = mockDb({ ...baseKey, eventIds: ["a", "b"] });
  const response = await events(request("/events?limit=1&cursor=0"), db);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { data: [{ eventId: "a" }], pagination: { hasMore: true, nextCursor: "a" } });
  assert.deepEqual(db.calls[1].where, { eventId: { in: ["a", "b"], gt: "0" } });
  assert.equal(db.calls[1].take, 2);
  for (const query of ["limit=501", "limit=-1", "limit=1&limit=2", "cursor=", "unexpected=1"]) {
    assert.equal((await events(request(`/events?${query}`), db)).status, 400);
  }
});
test("guests require access before fetching live Luma data, apply filters, and protect email fields", async () => {
  const db = mockDb();
  let fetches = 0;
  const live = async () => {
    fetches++;
    return { fetchedAt: "2026-10-27T20:00:00Z", guests: [
      normalizeLiveGuest({ id: "g-a", user_id: "a", user_name: "Fresh name", user_email: "fresh@example.test", approval_status: "approved", registered_at: "2026-10-27", event_tickets: [{ checked_in_at: "2026-10-27T10:00:00Z" }] }),
      normalizeLiveGuest({ id: "g-b", user_id: "b", approval_status: "waitlist" }),
    ] };
  };
  const response = await guests(request("/events/evt/guests?checked_in=true&status=checked_in&registered=true&approval_status=approved"), "evt", db, live);
  const result: any = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data[0].name, "Fresh name");
  assert.equal(result.data[0].checkedIn, true);
  assert.ok(!("email" in result.data[0]));
  assert.ok(!("person" in result.data[0]));
  assert.equal(result.source, "luma-live");
  assert.equal(result.complete, true);
  assert.equal(result.totalGuests, 2);
  assert.equal(result.fetchedAt, "2026-10-27T20:00:00Z");
  assert.match(result.requestId, /^integration-/);
  const emailDb = mockDb({ ...baseKey, scopes: [...baseKey.scopes, "guests:email"] });
  const emails: any = await (await guests(request(), "evt", emailDb, live)).json();
  assert.equal(emails.data[0].email, "fresh@example.test");
  const paged: any = await (await guests(request("/events/evt/guests?limit=1"), "evt", db, live)).json();
  assert.equal(paged.pagination.nextCursor, "a");
  const next: any = await (await guests(request("/events/evt/guests?cursor=a"), "evt", db, live)).json();
  assert.deepEqual(next.data.map((guest: any) => guest.personId), ["b"]);
  const denied: any = await (await guests(request("/events/evt/guests?approval_status=declined"), "evt", db, live)).json();
  assert.deepEqual(denied.data, []);
  const beforeDenied = fetches;
  assert.equal((await guests(request(), "other", mockDb({ ...baseKey, eventIds: ["evt"] }), live)).status, 403);
  assert.equal((await guests(request(), "evt", mockDb({ ...baseKey, scopes: ["events:read"] }), live)).status, 403);
  for (const query of ["checked_in=yes", "status=", "registered=1"]) assert.equal((await guests(request(`/events/evt/guests?${query}`), "evt", db, live)).status, 400);
  db.lumaEvent.findUnique = async () => null;
  assert.equal((await guests(request(), "missing", db, live)).status, 404);
  assert.equal(fetches, beforeDenied);
});
test("guest API fails closed when live Luma retrieval fails instead of serving the index", async () => {
  const db = mockDb();
  const response = await guests(request(), "evt", db, async () => { throw Object.assign(new Error("Complete live retrieval failed."), { status: 502 }); });
  assert.equal(response.status, 502);
  const result: any = await response.json();
  assert.equal(result.data, undefined);
  assert.match(result.requestId, /^integration-/);
  assert.equal(db.calls.length, 1); // Auth only; no indexed guest fallback.
});

test("database errors are sanitized", async () => {
  const db = mockDb();
  db.lumaEvent.findMany = async () => { throw new Error("private connection string"); };
  const response = await events(request(), db);
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes("connection string"));
});
test("admin keys need shared admin auth; creations store only hashes; revocation is bounded", async t => {
  const previousKey = process.env.GUESTBOOK_KEY;
  const previousUrl = process.env.DB_URL;
  const globalKey = "__guestbookPrismaClientV9";
  const previousDb = globalThis[globalKey];
  process.env.GUESTBOOK_KEY = "admin-test";
  process.env.DB_URL = "postgresql://unused.test/mocked";
  const writes: any[] = [];
  globalThis[globalKey] = { integrationApiKey: {
    create: async (args: any) => { writes.push(args); return { id: "new", name: args.data.name }; },
    updateMany: async (args: any) => { writes.push(args); return { count: 1 }; },
    findMany: async (args: any) => { assert.equal(args.select.keyHash, undefined); return []; },
  } };
  t.after(() => {
    globalThis[globalKey] = previousDb;
    if (previousKey === undefined) delete process.env.GUESTBOOK_KEY; else process.env.GUESTBOOK_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.DB_URL; else process.env.DB_URL = previousUrl;
  });
  const req = (body: any, headers: Record<string, string> = { "x-guestbook-key": "admin-test" }) => new Request("https://guestbook.test/api/admin/api-keys", { method: "POST", headers, body: JSON.stringify(body) });
  const config = { name: "Email", scopes: ["guests:read", "guests:email"], eventIds: ["evt"] };
  assert.equal((await createKey(req(config, { Authorization: `Bearer ${token.secret}` }))).status, 401);
  assert.equal((await createKey(req(config, { cookie: "guestbook_key=admin-test" }))).status, 401);
  for (const body of [{ ...config, scopes: ["write:all"] }, { ...config, scopes: ["guests:email"] }, { ...config, expiresAt: "invalid" }, { ...config, eventIds: [""] }]) assert.equal((await createKey(req(body))).status, 400);
  assert.equal(writes.length, 0);
  const response = await createKey(req(config));
  const result: any = await response.json();
  assert.equal(response.status, 201);
  assert.equal(writes[0].data.keyHash, hashKey(result.secret));
  assert.ok(!JSON.stringify(writes).includes(result.secret));
  assert.equal(writes[0].select.keyHash, undefined);
  assert.equal((await listKeys(new Request("https://test", { headers: { "x-guestbook-key": "admin-test" } }))).status, 200);
  assert.equal((await revokeKey(new Request("https://test?id=new", { method: "DELETE", headers: { "x-guestbook-key": "admin-test" } }))).status, 200);
  assert.deepEqual(writes[1].where, { id: "new", revokedAt: null });
});
