import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { listIndexedEventGuests, listIndexedMultiEventGuests } from "./db";
import { filterGuestPayload, guestQueryRequiresIndex, parseGuestListQuery } from "./guest-query";

test("Find requires the index and matches answers without cached search text", () => {
  const query = parseGuestListQuery(new URLSearchParams({ guest_search: "robotics" }));
  assert.equal(guestQueryRequiresIndex(query), true);
  const result = filterGuestPayload({
    people: [{ id: "match", name: "Ada" }, { id: "other", name: "Grace" }],
    guests: [
      { personId: "match", registrationAnswers: [{ label: "Interests", value: "Robotics" }] },
      { personId: "other", registrationAnswers: [] },
    ],
  }, query);
  assert.deepEqual(result.guests.map(guest => guest.personId), ["match"]);
});

// Never use .env or the application's database for test writes.
const url = process.env.ANSWER_SEARCH_TEST_DATABASE_URL;
test("single and multi-event searches query saved answers for the same person", async t => {
  const key = "__guestbookPrismaClientV9";
  const previous = { db: globalThis[key], url: process.env.DB_URL, mode: process.env.GUESTBOOK_IDENTITY_MODE };
  const queries: Prisma.Sql[] = [];
  globalThis[key] = {
    $queryRaw: async (query: Prisma.Sql) => { queries.push(query); return []; },
    lumaEventGuest: { findFirst: async () => ({ personId: "indexed" }) },
    guestbookEventGuest: { findFirst: async () => ({ personId: "indexed" }) },
    lumaEventSyncState: { findUnique: async () => null },
  };
  process.env.DB_URL = "postgresql://unused.test/mock";
  t.after(() => {
    globalThis[key] = previous.db;
    if (previous.url === undefined) delete process.env.DB_URL; else process.env.DB_URL = previous.url;
    if (previous.mode === undefined) delete process.env.GUESTBOOK_IDENTITY_MODE; else process.env.GUESTBOOK_IDENTITY_MODE = previous.mode;
  });
  const query = { ...parseGuestListQuery(new URLSearchParams({ guest_search: "Robotics", guest_status: "checked_in" })), includeSummary: false, includeEventCounts: false };
  for (const mode of ["legacy", "human"]) {
    process.env.GUESTBOOK_IDENTITY_MODE = mode;
    await listIndexedEventGuests("selected", query, undefined, { startsAt: null, date: null });
    await listIndexedMultiEventGuests(["selected", "second"], query);
    for (const sql of queries.splice(0)) {
      assert.match(sql.text, /answer_guest\.person_id = guest\.person_id/);
      assert.match(sql.text, /search_answer->>'value' ILIKE \$\d+/);
      assert.match(sql.text, /guest\.checked_in_at IS NOT NULL/);
      assert.match(sql.text, mode === "human" ? /FROM guestbook_event_guests AS answer_guest/ : /FROM luma_event_guests AS answer_guest/);
      assert.ok(sql.values.includes("%Robotics%"));
      assert.ok(sql.values.includes("selected"));
    }
  }
});

test("isolated database: Find searches past answers while preserving event/status filters", { skip: !url }, async t => {
  const socket = new URL(url!).searchParams.get("host") || "";
  assert.match(socket, /^\/private\/tmp\/guestbook-answer-search-test-[A-Za-z0-9]+$/);
  const db = new PrismaClient({ datasources: { db: { url } } });
  const key = "__guestbookPrismaClientV9";
  const previous = { db: globalThis[key], url: process.env.DB_URL, mode: process.env.GUESTBOOK_IDENTITY_MODE };
  t.after(async () => {
    globalThis[key] = previous.db;
    for (const [key, value] of [["DB_URL", previous.url], ["GUESTBOOK_IDENTITY_MODE", previous.mode]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await db.$disconnect();
  });
  const location = await db.$queryRaw<Array<{ data_directory: string }>>`SHOW data_directory`;
  assert.equal(location[0].data_directory, `${socket}/data`);
  await db.$executeRaw`CREATE OR REPLACE VIEW guestbook_active_people AS SELECT * FROM guestbook_people`;
  globalThis[key] = db;
  process.env.DB_URL = url;
  await db.lumaEvent.createMany({ data: ["old", "selected", "second"].map(eventId => ({ eventId, title: eventId })) });
  for (const mode of ["legacy", "human"]) {
    process.env.GUESTBOOK_IDENTITY_MODE = mode;
    const guests = mode === "human" ? db.guestbookEventGuest : db.lumaEventGuest;
    const data = ["past", "current", "wrong-status", "outside", "empty"].map(personId => ({ personId, name: personId }));
    if (mode === "human") await db.guestbookPerson.createMany({ data });
    else await db.lumaPerson.createMany({ data });
    await guests.createMany({ data: [
      ...["past", "current", "wrong-status", "outside"].map(personId => ({
        personId, eventId: "old", registrationAnswers: [{ label: "Interests", value: "Robotics" }],
      })),
      ...["past", "current", "wrong-status", "empty"].map(personId => ({
        personId, eventId: "selected", status: personId === "wrong-status" ? "declined" : "checked_in",
        registrationAnswers: personId === "current" ? [{ label: "Interests", value: "Robotics" }] : [],
      })),
      { personId: "past", eventId: "second", status: "checked_in" },
    ] });
    const query = { ...parseGuestListQuery(new URLSearchParams({ guest_search: "ROBOTICS", guest_status: "checked_in" })), includeSummary: false, includeEventCounts: false };
    const single = await listIndexedEventGuests("selected", query);
    assert.deepEqual(single.people.map(person => person.id).sort(), ["current", "past"], mode);
    assert.equal(single.pageInfo.total, 2);
    const multi = await listIndexedMultiEventGuests(["selected", "second"], query);
    assert.deepEqual(multi!.people.map(person => person.id).sort(), ["current", "past"], mode);
    assert.equal(multi!.pageInfo.total, 2);
  }
});
