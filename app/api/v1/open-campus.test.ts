import assert from "node:assert/strict";
import { test } from "node:test";
import { openCampusAnalytics } from "./analytics/open-campus/handler";

const secret = `gb_live_${"a".repeat(64)}`;
async function totals(response: Response) { const { drilldownLinks, ...rest } = (await response.json() as any).data; return rest; }
const request = (query = "") => new Request(`https://guestbook.test/api/v1/analytics/open-campus${query}`, { headers: { Authorization: `Bearer ${secret}` } });
function fixture() {
  const key = { scopes: ["events:read", "guests:read"], eventIds: ["evt-one"], revokedAt: null, expiresAt: null };
  const event = { eventId: "evt-one", title: "Open Campus", syncState: { lastGuestSyncAt: new Date("2026-01-01"), lastStatus: "success", truncated: false } };
  let query: any;
  const reads: any[] = [];
  const db: any = {
    integrationApiKey: { findUnique: async () => key },
    lumaEvent: { findMany: async (args: any) => { query = args; return [event, { ...event, eventId: "evt-other", title: "Open Campuses" }]; } },
    $queryRaw: async (sql: any) => { reads.push(sql); return sql.strings.join("").includes("attendee_tags") ? [] : [{ registered: 81, accepted: 23, checkedIn: 9, newRegistrations:40, firstRegisters:12,newFaces:5 }]; },
  };
  return { key, event, db, reads, query: () => query };
}
test("Open Campus totals respect event access and read only authorized event counts", async () => {
  const f = fixture();
  const response = await openCampusAnalytics(request(), f.db);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await totals(response), { registrations: 81, accepted: 23, checkedIn: 9, newPeople:{registrations:40,accepted:12,checkedIn:5}, eventCount: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(f.query().where.eventId, { in: ["evt-one"] });
  assert.equal(f.query().take, 501);
  assert.equal(f.reads.length, 3);
  assert(f.reads[0].values.includes("evt-one"));
  assert(!f.reads[0].values.includes("evt-other"));
  const sql = f.reads[0].strings.join("?");
  assert(sql.includes("COUNT(DISTINCT guest.person_id) FILTER"));
  assert(sql.includes("NOT guest.has_prior_event"));
  const newcomerSql = f.reads[2].strings.join("?");
  assert(newcomerSql.includes("previous_guest.checked_in_at"));
  assert(!newcomerSql.includes("has_prior_event"));
  assert(!/UPDATE|INSERT|DELETE/.test(sql));
  assert.equal(f.query().where.catalogActive, true);
});
test("Open Campus rejects missing scopes, bad queries, and incomplete indexes before counting", async () => {
  const f = fixture();
  assert.equal((await openCampusAnalytics(new Request("https://guestbook.test"), f.db)).status, 401);
  f.key.scopes = ["events:read"];
  assert.equal((await openCampusAnalytics(request(), f.db)).status, 403);
  f.key.scopes.push("guests:read");
  assert.equal((await openCampusAnalytics(request("?limit=1"), f.db)).status, 400);
  f.event.syncState.truncated = true;
  assert.equal((await openCampusAnalytics(request(), f.db)).status, 503);
  f.event.syncState.truncated = false;
  f.event.syncState.lastStatus = "error";
  assert.equal((await openCampusAnalytics(request(), f.db)).status, 503);
  assert.equal(f.reads.length, 0);
});
test("complete indexes need no overview cache, including valid skipped-fresh syncs", async () => {
  const f = fixture();
  f.event.syncState.lastStatus = "skipped_fresh";
  assert.equal((await openCampusAnalytics(request(), f.db)).status, 200);
  assert.equal(f.reads.length, 3);
});
test("Open Campus distinguishes a complete empty report from an oversized report", async () => {
  const f = fixture();
  f.db.lumaEvent.findMany = async () => [];
  const empty = await openCampusAnalytics(request(), f.db);
  assert.deepEqual(await totals(empty), { registrations: 0, accepted: 0, checkedIn: 0, newPeople:{registrations:0,accepted:0,checkedIn:0}, eventCount: 0, updatedAt: null });
  assert.equal(f.reads.length, 0);
  f.db.lumaEvent.findMany = async () => Array(501).fill(f.event);
  assert.equal((await openCampusAnalytics(request(), f.db)).status, 503);
});

test("30-day reports filter event dates at the database boundary and reject invalid periods", async () => {
  const f = fixture();
  const now = new Date("2026-11-20T12:00:00.000Z");
  assert.equal((await openCampusAnalytics(request("?period=30d"), f.db, now)).status, 200);
  assert.deepEqual(f.query().where.OR, [
    { startsAt: { gte: new Date("2026-10-21T12:00:00.000Z"), lte: now } },
    { startsAt: null, date: { gte: new Date("2026-10-21T12:00:00.000Z"), lte: now } },
  ]);
  for (const query of ["?period=7d", "?period=", "?period=30d&period=all"]) {
    assert.equal((await openCampusAnalytics(request(query), f.db, now)).status, 400);
  }
  assert.equal((await openCampusAnalytics(request("?period=all"), f.db, now)).status, 200);
  assert.deepEqual(f.query().where.OR, [
    { startsAt: { lte: now } },
    { startsAt: null, date: { lte: now } },
  ]);
});


test("custom date ranges include complete Pacific days across DST", async () => {
  const f = fixture();
  const now = new Date("2026-11-21T12:00:00Z");
  assert.equal((await openCampusAnalytics(request("?from=2026-11-01&to=2026-11-01"), f.db, now)).status, 200);
  assert.deepEqual(f.query().where.OR, [
    { startsAt: { gte: new Date("2026-11-01T07:00:00Z"), lt: new Date("2026-11-02T08:00:00Z"), lte: now } },
    { startsAt: null, date: { gte: new Date("2026-11-01T00:00:00Z"), lt: new Date("2026-11-02T00:00:00Z"), lte: now } },
  ]);
  await openCampusAnalytics(request("?from=2026-03-08&to=2026-03-08"), f.db, now);
  assert.equal(f.query().where.OR[0].startsAt.gte.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(f.query().where.OR[0].startsAt.lt.toISOString(), "2026-03-09T07:00:00.000Z");
  for (const query of ["?from=2026-11-01", "?to=2026-11-01", "?from=2026-02-30&to=2026-03-01", "?from=2026-11-20&to=2026-11-01", "?period=all&from=2026-11-01&to=2026-11-20", "?from=2026-11-01&from=2026-11-02&to=2026-11-20", "?from=9999-12-31&to=9999-12-31"]) {
    const before = f.reads.length;
    assert.equal((await openCampusAnalytics(request(query), f.db, now)).status, 400);
    assert.equal(f.reads.length, before);
  }
});

test("all-time attendance excludes upcoming events before index completeness checks", async () => {
  const f = fixture();
  const now = new Date("2026-11-22T12:00:00Z");
  assert.equal((await openCampusAnalytics(request(), f.db, now)).status, 200);
  assert.deepEqual(f.query().where.OR, [
    { startsAt: { lte: now } },
    { startsAt: null, date: { lte: now } },
  ]);
});


test("Open Campus links open the native workspace with exact events and status filters", async () => {
  const f = fixture();
  const response = await openCampusAnalytics(request("?from=2026-10-01&to=2026-11-22"), f.db, new Date("2026-11-23"));
  const links = (await response.json() as any).data.drilldownLinks;
  assert.equal(Object.keys(links).length, 6);
  const expected: Record<string, string> = { registrations: "registered", newRegistrations: "new_attendee_registered", accepted: "accepted", newAccepted: "new_attendee_accepted", checkedIn: "checked_in", newCheckedIn: "new_attendee_checked_in" };
  for (const [name, path] of Object.entries(links)) {
    const url = new URL(String(path), "https://guestbook.test");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("tab"), "overview");
    assert.equal(url.searchParams.get("event_view"), "all");
    assert.equal(url.searchParams.get("guest_status"), expected[name]);
    assert.deepEqual(url.searchParams.getAll("event"), ["evt-one"]);
    assert.equal(url.searchParams.has("profile"), false);
    assert.equal(url.searchParams.has("report"), false);
  }
});
