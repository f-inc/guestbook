import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  projectHumans,
  projectSourceAccounts,
  resolveHumanIds,
} from "./human-store";
import { humanClient } from "./human-mode";
import { preview } from "../people/merge/store";
import { mergeHumans, undoHumanMerge } from "../people/merge/humans";
import { verificationOverview } from "./email-verification";
import { chooseHumanRecipients } from "./invite-tracking-store";
import {
  searchIndexedPeople,
  resolveIndexedAudiencePersonIds,
  countIndexedAudience,
  getIndexedTrace,
  getIndexedLifetimeEventCounts,
  listIndexedAudiencePage,
  appendIndexedPersonComment,
  updateIndexedPersonComment,
  updateIndexedPersonPhoneNumber,
  removeIndexedEventGuestsMissingFromSnapshot,
  getIndexedMultiEventStats,
  listIndexedEventGuests,
  runAutomaticTagClassifier,
  mutateIndexedPersonTag,
  upsertNormalizedLumaGuestActivity,
  getIndexStats,
  matchIndexedPeopleByEmails,
} from "./db";
import { generateKey } from "../v1/shared";
import { guests as integrationGuests } from "../v1/events/[eventId]/guests/handler";
import { personEvents } from "../v1/people/[personId]/events/handler";
const url = process.env.HUMAN_IDENTITY_TEST_DATABASE_URL;
test(
  "isolated PostgreSQL: human migration, all selection paths, source sync, contacts, APIs and reversible human merges",
  { skip: !url },
  async (t) => {
    const socket = new URL(url!).searchParams.get("host");
    assert.ok(
      socket?.startsWith("/tmp/guestbook-human-") && socket.endsWith("/socket"),
      "Only an explicitly isolated Unix-socket fixture is allowed",
    );
    const db = new PrismaClient({ datasources: { db: { url } } });
    const [location]: any[] = await db.$queryRaw`SHOW data_directory`;
    assert.equal(
      location.data_directory,
      path.join(path.dirname(socket!), "data"),
    );
    const old = {
      mode: process.env.GUESTBOOK_IDENTITY_MODE,
      url: process.env.DB_URL,
      client: globalThis["__guestbookPrismaClientV9"],
      removal: process.env.EMAIL_REMOVAL_ENABLED,
    };
    t.after(async () => {
      await db.$disconnect();
      for (const [key, value] of Object.entries({
        GUESTBOOK_IDENTITY_MODE: old.mode,
        DB_URL: old.url,
        EMAIL_REMOVAL_ENABLED: old.removal,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      globalThis["__guestbookPrismaClientV9"] = old.client;
    });
    process.env.GUESTBOOK_IDENTITY_MODE = "human";
    process.env.DB_URL = url;
    process.env.EMAIL_REMOVAL_ENABLED = "true";
    globalThis["__guestbookPrismaClientV9"] = db;
    await db.$executeRawUnsafe(
      "DROP TABLE IF EXISTS guestbook_human_merges,guestbook_person_emails,guestbook_account_identities,guestbook_event_guests,guestbook_comments,guestbook_manual_tag_mutations,guestbook_automatic_tag_assignments,guestbook_people CASCADE",
    );
    await db.$executeRawUnsafe(
      "TRUNCATE luma_people,luma_events,guest_tags,email_addresses,luma_calendar_opt_outs,luma_invite_tracking CASCADE",
    );
    await db.lumaPerson.createMany({
      data: [
        {
          personId: "acct_a",
          name: "Alice Smith",
          email: "primary@example.test",
          tags: ["VIP"],
          manualTags: ["VIP"],
        },
        { personId: "acct_b", name: "Alice Work", email: "work@example.test" },
        {
          personId: "acct_c",
          name: "Alice Smith",
          email: "third@example.test",
          tags: ["Host"],
          manualTags: ["Host"],
        },
        {
          personId: "acct_d",
          name: "Different Human",
          email: "fourth@example.test",
        },
      ],
    });
    await db.personMergeMember.createMany({
      data: [
        { personId: "acct_a", canonicalId: "acct_a" },
        { personId: "acct_b", canonicalId: "acct_a" },
      ],
    });
    await db.lumaEvent.createMany({
      data: [1, 2, 3, 4].map((n) => ({
        eventId: `evt_${n}`,
        title: `Fixture ${n}`,
        startsAt: new Date(`2026-0${n}-01`),
        raw: { calendar_api_id: "fixture-calendar" },
      })),
    });
    await db.lumaEventGuest.createMany({
      data: [
        {
          eventId: "evt_1",
          personId: "acct_a",
          lumaGuestId: "g_a",
          status: "going",
          email: "primary@example.test",
        },
        {
          eventId: "evt_1",
          personId: "acct_b",
          lumaGuestId: "g_b",
          status: "checked_in",
          checkedInAt: new Date("2026-01-01"),
          email: "work@example.test",
        },
        {
          eventId: "evt_2",
          personId: "acct_b",
          lumaGuestId: "g_b2",
          status: "going",
        },
        {
          eventId: "evt_3",
          personId: "acct_c",
          lumaGuestId: "g_c",
          status: "going",
        },
        {
          eventId: "evt_4",
          personId: "acct_d",
          lumaGuestId: "g_d",
          status: "going",
        },
      ],
    });
    await db.guestComment.createMany({
      data: ["acct_a", "acct_b", "acct_c", "acct_d"].map((personId) => ({
        personId,
        body: `Fixture note ${personId}`,
      })),
    });
    await db.guestTag.createMany({
      data: [
        { id: "vip", name: "VIP" },
        { id: "host", name: "Host" },
      ],
    });
    await db.manualTagMutation.createMany({
      data: [
        { personId: "acct_a", tagId: "vip" },
        { personId: "acct_c", tagId: "host" },
      ],
    });
    const [identityColumn]: any[] =
      await db.$queryRaw`SELECT is_identity FROM information_schema.columns WHERE table_name='manual_tag_mutations' AND column_name='id'`;
    if (identityColumn.is_identity === "NO") {
      await db.$executeRawUnsafe(
        "ALTER TABLE manual_tag_mutations ALTER COLUMN id DROP DEFAULT",
      );
      await db.$executeRawUnsafe(
        "ALTER TABLE manual_tag_mutations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME fixture_manual_identity_seq)",
      );
    }
    const env = {
      ...process.env,
      PGHOST: socket!,
      PGDATABASE: "postgres",
      PGUSER: "haseab",
    };
    for (const file of [
      "20261116_add_human_identity.sql",
      "20261116_human_projection.sql",
    ]) {
      const result = spawnSync(
        "/opt/homebrew/opt/postgresql@17/bin/psql",
        [
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-f",
          path.resolve("prisma/manual-migrations", file),
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const humans = await db.guestbookPerson.findMany();
    assert.equal(humans.length, 3);
    const sourceNote = await db.guestComment.findFirstOrThrow({
      where: { personId: "acct_a" },
    });
    const initialHuman = await db.guestbookAccountIdentity.findUniqueOrThrow({
      where: { accountId: "acct_a" },
    });
    const reconcile = (approved: boolean) =>
      spawnSync(
        "/opt/homebrew/opt/postgresql@17/bin/psql",
        ["-X", "-q", "-v", "ON_ERROR_STOP=1"],
        {
          env,
          encoding: "utf8",
          input:
            (approved ? "SET guestbook.cutover_approved='true';\n" : "") +
            readFileSync(
              path.resolve(
                "prisma/manual-migrations/20261116_reconcile_human_cutover.sql",
              ),
              "utf8",
            ),
        },
      );
    await db.guestComment.update({
      where: { id: sourceNote.id },
      data: { body: "Updated during legacy rollout" },
    });
    await db.lumaPerson.update({
      where: { personId: "acct_a" },
      data: { phoneNumber: "+14155550199" },
    });
    assert.notEqual(
      reconcile(false).status,
      0,
      "Cutover requires explicit approval",
    );
    assert.equal(
      (
        await db.guestbookComment.findUniqueOrThrow({
          where: { id: sourceNote.id },
        })
      ).body,
      sourceNote.body,
    );
    const reconciled = reconcile(true);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.equal(
      (
        await db.guestbookComment.findUniqueOrThrow({
          where: { id: sourceNote.id },
        })
      ).body,
      "Updated during legacy rollout",
    );
    assert.equal(
      (
        await db.guestbookPerson.findUniqueOrThrow({
          where: { personId: initialHuman.personId },
        })
      ).phoneNumber,
      "+14155550199",
    );
    assert.equal(
      (
        await db.guestbookAccountIdentity.findUniqueOrThrow({
          where: { accountId: "acct_a" },
        })
      ).personId,
      initialHuman.personId,
    );
    await db.guestComment.update({
      where: { id: sourceNote.id },
      data: { body: sourceNote.body },
    });
    await db.lumaPerson.update({
      where: { personId: "acct_a" },
      data: { phoneNumber: null },
    });
    const restored = reconcile(true);
    assert.equal(restored.status, 0, restored.stderr);
    await projectHumans(
      db,
      humans.map((p) => p.personId),
    );
    const [a] = await resolveHumanIds(db, ["acct_a"]),
      [b] = await resolveHumanIds(db, ["acct_b"]),
      [c] = await resolveHumanIds(db, ["acct_c"]),
      [d] = await resolveHumanIds(db, ["acct_d"]);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith("human_"));
    assert.notEqual(a, "acct_a");
    const canonical = humanClient(db);
    assert.equal(await canonical.lumaPerson.count(), 3);
    assert.equal(await canonical.lumaEventGuest.count(), 4);
    const beforeSearch = await searchIndexedPeople("work@example.test");
    assert.equal(beforeSearch.people.length, 1);
    assert.equal(beforeSearch.people[0].person.id, a);
    assert.deepEqual(
      await resolveIndexedAudiencePersonIds(
        { includePersonIds: ["acct_a"], excludePersonIds: ["acct_b"] },
        { useCache: false },
      ),
      [],
    );
    assert.deepEqual(
      await resolveIndexedAudiencePersonIds(
        { includeEventCohorts: [{ eventId: "evt_1", cohort: "not_attended" }] },
        { useCache: false },
      ),
      [],
    );
    const beforePreview = await preview([a, c], canonical);
    assert.equal(
      beforePreview.events.find((e) => e.eventId === "evt_1")?.registrations,
      2,
    );
    assert.equal(
      (await matchIndexedPeopleByEmails(["work@example.test"]))[0].personId,
      a,
    );
    const first = await mergeHumans(db, a, c, a, [a, c]);
    assert.equal(await canonical.lumaPerson.count(), 2);
    assert.equal(
      (await searchIndexedPeople("third@example.test")).people[0].person.id,
      a,
    );
    const trace = await getIndexedTrace({ tracePersonId: c });
    assert.equal(trace.records.length, 3);
    assert.equal(trace.person.id, a);
    assert.equal(
      trace.records.find((r) => r.eventId === "evt_1")?.status,
      "checked_in",
    );
    const counts = await getIndexedLifetimeEventCounts("evt_1", [a]);
    assert.equal(counts.counts[0].registered, 3);
    assert.equal(counts.counts[0].attended, 1);
    const audience = await listIndexedAudiencePage({
      includePersonIds: [a],
      excludeExistingEventIds: ["evt_3"],
    });
    assert.equal(audience.pageInfo.eligibleTotal, 0);
    assert.equal(audience.people[0].alreadyInTargetEvent, true);
    assert.deepEqual(
      await resolveIndexedAudiencePersonIds(
        { includePersonIds: [a], excludeExistingEventIds: ["evt_3"] },
        { useCache: false },
      ),
      [],
    );
    assert.equal(
      (
        await countIndexedAudience({
          includePersonIds: ["acct_a"],
          excludePersonIds: ["acct_c"],
        })
      ).total,
      0,
    );
    const eventPage = await listIndexedEventGuests("evt_1");
    assert.equal(eventPage.guests.length, 1);
    assert.equal(eventPage.people[0].id, a);
    const multi = await getIndexedMultiEventStats(["evt_1", "evt_2"]);
    assert.equal(multi?.stats.registered, 1);
    assert.equal(multi?.stats.checkedIn, 1);
    const classifier = await runAutomaticTagClassifier({
      forceFull: true,
      dryRun: false,
    });
    assert.equal(classifier.evaluatedCount, 2);
    await db.emailAddress.create({
      data: {
        emailLower: "primary@example.test",
        state: "undeliverable",
        checkedAt: new Date(),
      },
    });
    const sends = await chooseHumanRecipients(
      [
        { personId: a, email: "primary@example.test" },
        { personId: a, email: "third@example.test" },
      ],
      canonical,
      "evt_4",
    );
    assert.equal(sends.length, 1);
    assert.notEqual(sends[0].email, "primary@example.test");
    await db.lumaCalendarOptOut.create({
      data: { emailLower: sends[0].email, calendarId: "fixture-calendar" },
    });
    const fallback = await chooseHumanRecipients(
      [{ personId: a, email: sends[0].email }],
      canonical,
      "evt_4",
    );
    assert.notEqual(fallback[0].email, sends[0].email);
    assert.notEqual(fallback[0].email, "primary@example.test");
    assert.equal(
      (
        await chooseHumanRecipients(
          [{ email: "third@example.test" }],
          canonical,
          "evt_4",
        )
      ).length,
      1,
    );
    const secret = generateKey();
    await db.integrationApiKey.create({
      data: {
        name: "Fixture",
        keyHash: secret.keyHash,
        prefix: secret.prefix,
        scopes: ["events:read", "guests:read"],
        eventIds: ["evt_1"],
      },
    });
    const request = new Request(
      "https://guestbook.test/api/v1/events/evt_1/guests",
      { headers: { Authorization: `Bearer ${secret.secret}` } },
    );
    const api = await integrationGuests(
      request,
      "evt_1",
      canonical,
      async () => ({
        guests: [
          {
            personId: "acct_a",
            lumaGuestId: "g_a",
            name: "Alice",
            status: "going",
            checkedIn: false,
            registeredAt: new Date().toISOString(),
            email: "primary@example.test",
          },
          {
            personId: "acct_b",
            lumaGuestId: "g_b",
            name: "Alice",
            status: "checked_in",
            checkedIn: true,
            email: "work@example.test",
          },
        ] as any,
        fetchedAt: new Date().toISOString(),
      }),
    );
    const apiBody: any = await api.json();
    assert.equal(api.status, 200, JSON.stringify(apiBody));
    assert.equal(apiBody.data.length, 1);
    assert.equal(apiBody.data[0].personId, a);
    assert.equal(apiBody.data[0].name, "Alice Smith");
    assert.equal(apiBody.data[0].email, undefined);
    const history: any = await (
      await personEvents(
        new Request("https://guestbook.test/api/v1/people/acct_b/events", {
          headers: { Authorization: `Bearer ${secret.secret}` },
        }),
        "acct_b",
        canonical,
      )
    ).json();
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].personId, a);
    const note = await appendIndexedPersonComment({
      personId: c,
      body: "New human-owned note",
      author: "Fixture",
    });
    assert.equal(note.personId, a);
    await updateIndexedPersonComment({
      personId: a,
      commentId: note.id,
      body: "Edited after merge",
    });
    await db.guestTag.update({
      where: { id: "vip" },
      data: { name: "Priority" },
    });
    for (const person of await db.guestbookPerson.findMany()) {
      const replace = (tags: any) =>
        (tags as string[]).map((name) => (name === "VIP" ? "Priority" : name));
      await db.guestbookPerson.update({
        where: { personId: person.personId },
        data: {
          manualTags: replace(person.manualTags),
          tags: replace(person.tags),
        },
      });
    }
    await mutateIndexedPersonTag({
      personId: a,
      tagId: "vip",
      eventId: null,
      removed: true,
    });
    const second = await mergeHumans(db, a, d, a, [a, d]);
    await assert.rejects(undoHumanMerge(db, first.id), /newer merges/);
    await undoHumanMerge(db, second.id);
    await undoHumanMerge(db, first.id);
    assert.equal(await canonical.lumaPerson.count(), 3);
    assert.equal(
      (await db.guestbookComment.findUnique({ where: { id: note.id } }))?.body,
      "Edited after merge",
    );
    assert.equal(
      (await db.guestbookComment.findUnique({ where: { id: note.id } }))
        ?.personId,
      a,
    );
    assert.ok(
      !(
        (await db.guestbookPerson.findUnique({ where: { personId: a } }))!
          .manualTags as string[]
      ).includes("VIP"),
    );
    assert.ok(
      (
        (await db.guestbookPerson.findUnique({ where: { personId: c } }))!
          .manualTags as string[]
      ).includes("Host"),
    );
    await updateIndexedPersonPhoneNumber("acct_b", "+1 415 555 0123");
    assert.equal(
      (await db.guestbookPerson.findUnique({ where: { personId: a } }))
        ?.phoneNumber,
      "+1 415 555 0123",
    );
    assert.equal(
      (await db.lumaPerson.findUnique({ where: { personId: "acct_b" } }))
        ?.phoneNumber,
      null,
    );
    await removeIndexedEventGuestsMissingFromSnapshot({
      eventId: "evt_1",
      personIds: ["acct_b"],
    });
    assert.equal(
      await db.lumaEventGuest.count({ where: { eventId: "evt_1" } }),
      1,
    );
    assert.equal(
      await canonical.lumaEventGuest.count({ where: { eventId: "evt_1" } }),
      1,
    );
    await db.lumaPerson.create({
      data: {
        personId: "new_account",
        name: "New Account",
        email: "work@example.test",
      },
    });
    await upsertNormalizedLumaGuestActivity({
      event: { id: "evt_4" },
      guest: {
        personId: "new_account",
        person: {
          id: "new_account",
          name: "New Account",
          email: "work@example.test",
        },
        lumaGuestId: "g_new",
        status: "going",
      },
      rawGuest: {},
    });
    const [newHuman] = await resolveHumanIds(db, ["new_account"]);
    assert.notEqual(
      newHuman,
      a,
      "A shared email must never automatically merge humans",
    );
    assert.equal(await db.lumaPerson.count(), 5);
    assert.equal(await db.lumaEventGuest.count(), 5);
    assert.equal(await canonical.lumaEventGuest.count(), 5);
    assert.equal(await db.guestComment.count(), 4);
    assert.equal(await db.guestbookComment.count(), 5);
    assert.equal((await getIndexStats()).personCount, 4);
    await verificationOverview("work@example.test", "all", 0, canonical);
    await assert.rejects(
      getIndexedTrace({ traceEmail: "work@example.test" }),
      /multiple people/,
    );
    const exact = await getIndexedTrace({
      tracePersonId: a,
      traceEmail: "work@example.test",
    });
    assert.equal(exact.person.id, a);
    assert.equal(exact.records.length, 2);
    const [concurrent] = await Promise.all([
      mergeHumans(db, c, d, c, [c, d]),
      upsertNormalizedLumaGuestActivity({
        event: { id: "evt_2" },
        guest: {
          personId: "acct_d",
          person: {
            id: "acct_d",
            name: "Different Human",
            email: "fourth@example.test",
          },
          lumaGuestId: "g_d2",
          status: "going",
        },
        rawGuest: {},
      }),
    ]);
    assert.equal(
      await db.guestbookEventGuest.count({
        where: { eventId: "evt_2", personId: c },
      }),
      1,
    );
    await undoHumanMerge(db, concurrent.id);
    assert.equal(
      await db.guestbookEventGuest.count({
        where: { eventId: "evt_2", personId: d },
      }),
      1,
    );
  },
);
