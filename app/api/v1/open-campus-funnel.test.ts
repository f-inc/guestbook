import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenCampusFunnel,
  evaluateOpenCampusFunnel,
  type FunnelEvent,
  type FunnelGuest,
} from "./analytics/open-campus-funnel/cohort";
import { openCampusFunnel } from "./analytics/open-campus-funnel/handler";
const now = new Date("2026-06-01T00:00:00Z");
const query = { from: "2026-01-01", to: "2026-02-01" };
const event = (eventId: string, title = "Workshop"): FunnelEvent => ({
  eventId,
  title,
  location: "Hall",
  category: "Community",
  startsAt: new Date("2026-01-02T19:00:00Z"),
  endsAt: new Date("2026-01-02T21:00:00Z"),
});
const row = (eventId: string, personId: string, extra: Partial<FunnelGuest> = {}): FunnelGuest => ({
  eventId,
  personId,
  emailLower: `${personId}@example.test`,
  registeredAt: new Date("2026-01-01T19:00:00Z"),
  approvedAt: new Date("2026-01-01T20:00:00Z"),
  checkedInAt: new Date("2026-01-02T20:00:00Z"),
  status: "checked_in",
  ...extra,
});
const date = (value: string) => new Date(`${value}T20:00:00Z`);
const later = (person: string, extra: Partial<FunnelGuest> = {}) =>
  row("open", person, {
    registeredAt: date("2026-02-03"),
    approvedAt: date("2026-02-04"),
    checkedInAt: date("2026-02-05"),
    ...extra,
  });
const events = [event("other"), event("repeat"), event("open", "Community: Open Campus")];

test("cohort deduplicates visits and email aliases, excludes Open Campus first visits and follows later outcomes outside date range", () => {
  const guests = [
    row("other", "one"),
    row("repeat", "one", { checkedInAt: date("2026-01-03") }),
    later("one"),
    row("other", "duplicate", { emailLower: " ONE@example.test " }),
    later("duplicate", { emailLower: "one@example.test" }),
    row("open", "open-first"),
    row("other", "open-first", { checkedInAt: date("2026-01-03") }),
    row("other", "registered"),
    later("registered", { approvedAt: null, checkedInAt: null, status: "waitlisted" }),
    row("other", "accepted"),
    later("accepted", { checkedInAt: null, status: "going" }),
  ];
  const result = buildOpenCampusFunnel(events, guests, query, now);
  assert.deepEqual(result, {
    firstVisit: 3,
    registered: 3,
    accepted: 2,
    checkedIn: 1,
    guestPass: null,
    excludedMissingCheckInTime: 0,
    checkedInWithoutMatchableEmail: 0,
  });
  assert(!JSON.stringify(result).includes("example.test"));
});
test("requires a later registration and same-event ordered check-in; missing first-check-in times are excluded", () => {
  const guests = [
    row("other", "early"),
    later("early", { registeredAt: date("2025-12-31") }),
    row("other", "missing", { checkedInAt: null }),
    later("missing"),
    row("other", "bad-order"),
    later("bad-order", { checkedInAt: date("2026-02-02") }),
    row("other", "no-email", { emailLower: null }),
    later("no-email", { emailLower: null }),
  ];
  assert.deepEqual(buildOpenCampusFunnel(events, guests, query, now), {
    firstVisit: 3,
    registered: 2,
    accepted: 2,
    checkedIn: 1,
    guestPass: null,
    excludedMissingCheckInTime: 1,
    checkedInWithoutMatchableEmail: 1,
  });
  assert.equal(
    buildOpenCampusFunnel(events, guests, { ...query, location: "Other" }, now).firstVisit,
    0,
  );
  assert.equal(
    buildOpenCampusFunnel(events, guests, { ...query, category: "Other" }, now).firstVisit,
    0,
  );
});
test("Pacific first-visit boundaries, prior history and future outcomes stay out of the cohort", () => {
  const guests = [
    row("other", "previous", { checkedInAt: new Date("2026-01-01T07:59:00Z") }),
    later("previous"),
    row("other", "inside", { checkedInAt: new Date("2026-01-01T08:00:00Z") }),
    later("inside", {
      registeredAt: date("2026-06-02"),
      approvedAt: null,
      checkedInAt: null,
      status: "registered",
    }),
  ];
  const result = buildOpenCampusFunnel(events, guests, query, now);
  assert.equal(result.firstVisit, 1);
  assert.equal(result.registered, 0);
});

const token = `gb_live_${"a".repeat(64)}`;
const request = (body: unknown = query, authorization = `Bearer ${token}`) =>
  new Request("https://events.example.test/api/v1/analytics/open-campus-funnel", {
    method: "POST",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
function fixture() {
  let scopes = ["events:read", "guests:read"],
    revocation: Date | null = null;
  let reads = 0;
  const syncState = {
    lastGuestSyncAt: date("2026-03-01"),
    lastStatus: "success",
    truncated: false,
  };
  let catalog = events.map((event) => ({ ...event, syncState }));
  const db = {
    integrationApiKey: {
      findUnique: async () => ({
        scopes,
        eventIds: ["other", "repeat", "open"],
        revokedAt: revocation,
        expiresAt: null,
      }),
    },
    $transaction: async (callback: any, options: any) => {
      reads++;
      assert.equal(options.isolationLevel, "RepeatableRead");
      return callback({
        lumaEvent: {
          findMany: async (args: any) => {
            assert.deepEqual(args.where.eventId.in, ["other", "repeat", "open"]);
            return catalog;
          },
        },
        lumaEventGuest: {
          findMany: async (args: any) => {
            assert.deepEqual(
              args.where.eventId.in,
              catalog.map((event) => event.eventId),
            );
            return [row("other", "one"), later("one")];
          },
        },
      });
    },
  };
  return {
    db: db as any,
    getReads: () => reads,
    setScopes: (value: string[]) => {
      scopes = value;
    },
    revoke: () => {
      revocation = now;
    },
    setCatalog: (value: any) => {
      catalog = value;
    },
    catalog,
  };
}
test("aggregate API enforces scopes, date/schema validation, scoped history and no personal output", async () => {
  const f = fixture();
  assert.equal((await openCampusFunnel(request(undefined, ""), f.db, now)).status, 401);
  f.setScopes(["events:read"]);
  assert.equal((await openCampusFunnel(request(), f.db, now)).status, 403);
  f.setScopes(["events:read", "guests:read"]);
  for (const body of [
    { ...query, to: "2028-01-01" },
    { ...query, from: "2026-02-30" },
    { ...query, passes: [] },
    { ...query, status: "invalid" },
  ])
    assert.equal((await openCampusFunnel(request(body), f.db, now)).status, 400);
  assert.equal(f.getReads(), 0);
  const response = await openCampusFunnel(request(), f.db, now);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body: any = await response.json();
  assert.equal(body.data.firstVisit, 1);
  assert.equal(body.data.coverage.restrictedHistory, true);
  for (const text of ["personId", "emailLower", "example.test", token])
    assert(!JSON.stringify(body).includes(text));
  f.setCatalog([{ ...f.catalog[0], syncState: null }]);
  const partial: any = await (await openCampusFunnel(request(), f.db, now)).json();
  assert.equal(partial.data.coverage.historyComplete, false);
  f.revoke();
  assert.equal((await openCampusFunnel(request(), f.db, now)).status, 401);
});
test("event history over the hard bound fails instead of silently truncating", async () => {
  const f = fixture();
  f.setCatalog(Array.from({ length: 2001 }, () => f.catalog[0]));
  assert.equal((await openCampusFunnel(request(), f.db, now)).status, 503);
});

test("drill-down membership is exactly the same cohort at every stage", () => {
  const guests = [
    row("other", "one"),
    later("one"),
    row("other", "two"),
    later("two", { checkedInAt: null, status: "going" }),
  ];
  const result = evaluateOpenCampusFunnel(events, guests, query, now);
  for (const key of ["firstVisit", "registered", "accepted", "checkedIn"] as const)
    assert.equal(result.counts[key], result.members[key].length);
  assert.deepEqual(
    result.members.checkedIn.map((row) => row.personId),
    ["one"],
  );
  assert(!JSON.stringify(buildOpenCampusFunnel(events, guests, query, now)).includes("personId"));
});
