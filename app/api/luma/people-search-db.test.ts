import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { searchIndexedPeople } from "./db";

// Never load .env or fall back to the application's potentially production DB.
const url = process.env.PEOPLE_SEARCH_TEST_DATABASE_URL;
test("isolated database: search ranking, filters, pagination and complete profiles in one query", { skip: !url }, async t => {
  const target = new URL(url!);
  const socket = target.searchParams.get("host") || "";
  assert.match(socket, /^\/private\/tmp\/guestbook-search-test-[A-Za-z0-9]+$/);
  const db = new PrismaClient({ datasources: { db: { url } } });
  const key = "__guestbookPrismaClientV9";
  const previous = { db: globalThis[key], url: process.env.DB_URL, removal: process.env.EMAIL_REMOVAL_ENABLED };
  t.after(async () => {
    globalThis[key] = previous.db;
    if (previous.url === undefined) delete process.env.DB_URL; else process.env.DB_URL = previous.url;
    if (previous.removal === undefined) delete process.env.EMAIL_REMOVAL_ENABLED; else process.env.EMAIL_REMOVAL_ENABLED = previous.removal;
    await db.$disconnect();
  });
  const location = await db.$queryRaw<any[]>`SHOW data_directory`;
  assert.equal(location[0].data_directory, `${socket}/data`);
  process.env.DB_URL = url;
  process.env.EMAIL_REMOVAL_ENABLED = "true";
  await db.$executeRaw`CREATE TABLE IF NOT EXISTS guestbook_inactive_people (person_id TEXT PRIMARY KEY)`;
  await db.$executeRaw`TRUNCATE luma_people, luma_events, guest_tags, guestbook_inactive_people CASCADE`;
  const now = new Date("2026-11-01T12:00:00Z");
  await db.lumaPerson.createMany({ data: [
    { personId: "exact", name: "Alex", email: "guest@example.test", phoneNumber: "+1 (415) 555-0100", tags: ["VIP", "Host"], lastSeenAt: now },
    { personId: "email", name: "Email exact", email: "alex", lastSeenAt: now },
    { personId: "prefix", name: "Alex Chen", lastSeenAt: now },
    { personId: "email-prefix", name: "Email prefix", email: "alex@example.test", lastSeenAt: now },
    { personId: "substring", name: "Malex", lastSeenAt: now },
    { personId: "comment", name: "Comment match", lastSeenAt: now },
    { personId: "tag", name: "Tag match", tags: ["alex tag"], lastSeenAt: now },
    { personId: "guest", name: "Guest answer", lastSeenAt: now },
    { personId: "inactive", name: "Alex inactive", lastSeenAt: now },
    { personId: "literal", name: "100%_\\literal", lastSeenAt: now },
  ] });
  await db.guestTag.create({ data: { id: "alex-tag", name: "alex tag" } });
  await db.guestComment.createMany({ data: [
    { personId: "exact", body: "older alex comment", createdAt: now },
    { personId: "exact", body: "latest alex comment", createdAt: now },
    { personId: "comment", body: "alex comment only", createdAt: now },
  ] });
  await db.lumaEvent.createMany({ data: [
    { eventId: "old", title: "Old", startsAt: new Date("2026-10-01") },
    { eventId: "new", title: "New", startsAt: now },
    { eventId: "cancelled", title: "Cancelled", startsAt: new Date("2026-10-02"), raw: { status: "cancelled" } },
  ] });
  await db.lumaEventGuest.createMany({ data: [
    { eventId: "old", personId: "exact", status: "going" },
    { eventId: "new", personId: "exact", status: "checked_in", searchText: "alex", phoneNumber: "+1 415 555 9999" },
    { eventId: "cancelled", personId: "exact", status: "checked_in" },
    { eventId: "new", personId: "guest", status: "invited", searchText: "alex", phoneNumber: "+1 (212) 555-0100" },
  ] });
  await db.$executeRaw`INSERT INTO guestbook_inactive_people VALUES ('inactive')`;
  let queries = 0;
  // Deliberately expose no findMany: all result data must come from this read.
  globalThis[key] = { $queryRaw: (sql: Prisma.Sql) => { queries++; return db.$queryRaw(sql); } };
  const result = await searchIndexedPeople(" ALEX ", { limit: 20 });
  assert.equal(queries, 1);
  assert.deepEqual(result.people.map(row => row.person.id), ["exact", "email", "prefix", "email-prefix", "comment", "substring", "tag", "guest"]);
  const person = result.people[0].person;
  assert.equal(person.name, "Alex");
  assert.equal(person.email, "guest@example.test");
  assert.deepEqual(person.tags, ["VIP", "Host"]);
  assert.equal(person.phoneNumber, "+1 (415) 555-0100");
  assert.equal(person.crmNotes, "latest alex comment");
  assert.equal(person.crmNoteCount, 2);
  assert.equal(person.crmNotesUpdatedAt, now.toISOString());
  assert.deepEqual(person.eventCounts, { attended: 1, registered: 2 });
  assert.equal(result.people[0].eventId, "new");
  assert.equal(result.people.at(-1)!.person.phoneNumber, "+1 (212) 555-0100");
  assert.equal(result.hasMore, false);
  const ids = async (query: string, options = {}) => (await searchIndexedPeople(query, options)).people.map(row => row.person.id);
  assert.deepEqual(await ids("alex", { includedTags: ["VIP", "Host"], tagMode: "all" }), ["exact"]);
  assert.deepEqual(await ids("alex", { includedTags: ["VIP"], excludedTags: ["Host"] }), []);
  assert.deepEqual(await ids("alex", { comments: "with" }), ["exact", "comment"]);
  assert.ok(!(await ids("alex", { comments: "without" })).includes("comment"));
  assert.deepEqual(await ids("+1 415-555-0100"), ["exact"]);
  assert.deepEqual(await ids("+1 212-555-0100"), ["guest"]);
  assert.deepEqual(await ids("%_\\"), ["literal"]);
  const first = await searchIndexedPeople("alex", { limit: 3 });
  const second = await searchIndexedPeople("alex", { limit: 3, offset: first.nextOffset });
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 3);
  assert.deepEqual([...first.people, ...second.people].map(row => row.person.id), result.people.slice(0, 6).map(row => row.person.id));
  assert.equal((await searchIndexedPeople("absent")).hasMore, false);
  assert.equal((await searchIndexedPeople("", { limit: 20 })).people.length, 9);
});
