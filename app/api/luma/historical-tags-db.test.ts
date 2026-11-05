import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { listIndexedEventGuests, listIndexedEventGuestMutationTargets, listIndexedMultiEventGuests, searchIndexedPeople } from "./db";
import { eventGuestWhere, type GuestListQuery } from "./guest-query";

// This test never loads .env or uses the application's configured database.
const url = process.env.TAG_HISTORY_TEST_DATABASE_URL;
test("isolated database: manual tag history matches consistently across people, event and multi-event filters", { skip: !url }, async t => {
  const target = new URL(url!);
  const socket = target.searchParams.get("host") || "";
  assert.match(socket, /^\/private\/tmp\/guestbook-tag-history-test-[A-Za-z0-9]+$/);
  const db = new PrismaClient({ datasources: { db: { url } } });
  const location = await db.$queryRaw<Array<{ data_directory: string }>>`SHOW data_directory`;
  assert.equal(location[0].data_directory, `${socket}/data`);
  const key = "__guestbookPrismaClientV9";
  const previous = { db: globalThis[key], url: process.env.DB_URL, removal: process.env.EMAIL_REMOVAL_ENABLED };
  t.after(async () => {
    globalThis[key] = previous.db;
    if (previous.url === undefined) delete process.env.DB_URL; else process.env.DB_URL = previous.url;
    if (previous.removal === undefined) delete process.env.EMAIL_REMOVAL_ENABLED; else process.env.EMAIL_REMOVAL_ENABLED = previous.removal;
    await db.$disconnect();
  });
  globalThis[key] = db;
  process.env.DB_URL = url;
  process.env.EMAIL_REMOVAL_ENABLED = "false";
  const ids = ["active", "removed", "readded", "never", "removal-only", "legacy"];
  await db.lumaPerson.createMany({ data: ids.map(personId => ({
    personId, name: `History ${personId}`, tags: ["active", "readded", "legacy"].includes(personId) ? ["VIP"] : [],
    manualTags: ["active", "readded", "legacy"].includes(personId) ? ["VIP"] : [],
  })) });
  await db.guestTag.createMany({ data: [
    { id: "vip", name: "VIP" }, { id: "host", name: "Host" },
    { id: "auto", name: "Automatic", managed: true, ruleKey: "power_user" },
    { id: "quote", name: "Founder's circle" },
  ] });
  await db.lumaEvent.createMany({ data: [
    { eventId: "event-1", title: "One" }, { eventId: "event-2", title: "Two" },
  ] });
  await db.lumaEventGuest.createMany({ data: ids.flatMap(personId => ["event-1", "event-2"].map(eventId => ({
    personId, eventId, status: "going", lumaGuestId: `${eventId}-${personId}`,
  }))) });
  const first = new Date("2026-01-01");
  const second = new Date("2026-02-01");
  await db.manualTagMutation.createMany({ data: [
    { personId: "active", tagId: "vip", assignedAt: first, assignedEventId: "event-1" },
    { personId: "removed", tagId: "vip", assignedAt: first, assignedEventId: "event-2" },
    { personId: "removed", tagId: "vip", assignedAt: second, removed: true },
    { personId: "readded", tagId: "vip", assignedAt: first },
    { personId: "readded", tagId: "vip", assignedAt: second, removed: true },
    { personId: "readded", tagId: "vip", assignedAt: new Date("2026-03-01") },
    { personId: "removal-only", tagId: "vip", assignedAt: second, removed: true },
    { personId: "legacy", tagId: "vip", assignedAt: null },
    { personId: "removed", tagId: "host", assignedAt: first },
    { personId: "removed", tagId: "host", assignedAt: second, removed: true },
    { personId: "never", tagId: "auto", assignedAt: first },
    { personId: "active", tagId: "quote", assignedAt: first },
  ] });
  const query = (tags = ["VIP"], excludedTags: string[] = [], tagMode: "any" | "all" = "any"): GuestListQuery => ({
    filter: "all", search: "", tags, excludedTags, tagMode, tagScope: "ever", cursor: 0, pageSize: 50, includeSummary: false, includeEventCounts: false,
  });
  const sorted = (values: string[]) => values.sort();
  const check = async (q: GuestListQuery, expected: string[]) => {
    const people = await searchIndexedPeople("History", { includedTags: q.tags, excludedTags: q.excludedTags, tagMode: q.tagMode, tagScope: "ever", limit: 20 });
    const event = await listIndexedEventGuests("event-1", q);
    const multi = await listIndexedMultiEventGuests(["event-1", "event-2"], q);
    const selected = await listIndexedEventGuestMutationTargets("event-1", q);
    const orm = await db.lumaEventGuest.findMany({ where: eventGuestWhere("event-1", q), select: { personId: true } });
    for (const actual of [people.people.map(row => row.person.id), event.people.map(row => row.id), multi!.people.map(row => row.id), selected.map(row => row.personId), orm.map(row => row.personId)]) {
      assert.deepEqual(sorted(actual), sorted([...expected]));
    }
    assert.equal(multi!.pageInfo.total, expected.length);
  };
  await check(query(), ["active", "removed", "readded", "legacy"]);
  await check(query(["vip"]), ["active", "removed", "readded", "legacy"]);
  await check(query(["VIP", "Host"], [], "all"), ["removed"]);
  await check(query(["VIP"], ["Host"]), ["active", "readded", "legacy"]);
  await check(query([], ["VIP"]), ["never", "removal-only"]);
  await check(query(["Automatic"]), []);
  await check(query(["Founder's circle"]), ["active"]);
  const current = await searchIndexedPeople("", { includedTags: ["VIP"], limit: 20 });
  assert.deepEqual(sorted(current.people.map(row => row.person.id)), ["active", "legacy", "readded"]);
  const firstPage = await searchIndexedPeople("", { tagScope: "ever", includedTags: ["VIP"], limit: 2 });
  const nextPage = await searchIndexedPeople("", { tagScope: "ever", includedTags: ["VIP"], limit: 2, offset: firstPage.nextOffset });
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(sorted([...firstPage.people, ...nextPage.people].map(row => row.person.id)), ["active", "legacy", "readded", "removed"]);
  const firstEvent = await listIndexedEventGuests("event-1", { ...query(), pageSize: 2 });
  const nextEvent = await listIndexedEventGuests("event-1", { ...query(), pageSize: 2, cursor: 2 });
  assert.equal(firstEvent.pageInfo.hasMore, true);
  assert.deepEqual(sorted([...firstEvent.people, ...nextEvent.people].map(row => row.id)), ["active", "legacy", "readded", "removed"]);
});
