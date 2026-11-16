import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { humanClient, humanSql } from "./human-mode";
test("human SQL changes table identifiers while preserving bound values and mutation targets", () => {
  const query = humanSql(
    Prisma.sql`UPDATE luma_people SET name=${"luma_people"} WHERE person_id IN (SELECT person_id FROM luma_people) RETURNING person_id`,
  );
  assert.match(query.sql, /UPDATE guestbook_people/);
  assert.match(query.sql, /FROM guestbook_active_people/);
  assert.deepEqual(query.values, ["luma_people"]);
});
test("the rollout gate preserves legacy delegates and human mode selects authoritative models", async () => {
  const previous = process.env.GUESTBOOK_IDENTITY_MODE;
  const calls: any[] = [];
  const source: any = {
    lumaPerson: { count: () => Promise.resolve(99) },
    guestbookPerson: {
      count: (input: any) => {
        calls.push(input);
        return Promise.resolve(2);
      },
    },
    lumaEvent: {
      findMany: async (input: any) => {
        calls.push(input);
        return [{ humanGuests: [{ personId: "human_fixture" }] }];
      },
    },
  };
  try {
    delete process.env.GUESTBOOK_IDENTITY_MODE;
    assert.equal(humanClient(source), source);
    process.env.GUESTBOOK_IDENTITY_MODE = "human";
    const db = humanClient(source);
    assert.equal(await db.lumaPerson.count(), 2);
    assert.deepEqual(calls[0].where, { AND: [{}, { mergedIntoId: null }] });
    const rows = await db.lumaEvent.findMany({
      select: { guests: { select: { personId: true } } },
    });
    assert.deepEqual(rows, [{ guests: [{ personId: "human_fixture" }] }]);
    assert.ok(calls[1].select.humanGuests);
  } finally {
    if (previous === undefined) delete process.env.GUESTBOOK_IDENTITY_MODE;
    else process.env.GUESTBOOK_IDENTITY_MODE = previous;
  }
});
