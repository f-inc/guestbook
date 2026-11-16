import assert from "node:assert/strict";
import test from "node:test";
import { mergePeople, undoMerge } from "../people/merge/store";
import { linkedPersonIds } from "./merge-identity";
import { POST, DELETE, GET } from "../people/merge/route";

type Member = { personId: string; canonicalId: string };
function database() {
  let members: Member[] = [];
  let operations: Array<{ id: string; before: Member[]; after: Member[]; undoneAt: Date | null }> = [];
  const calls: string[] = [];
  const db: any = {
    lumaPerson: { findMany: async ({ where }: any) => where.personId.in.filter((id: string) => id !== "missing").map((personId: string) => ({ personId })) },
    $queryRaw: async (query: any, ...args: any[]) => {
      const sql = Array.isArray(query) ? query.join("?") : query.sql;
      const values = Array.isArray(query) ? args : query.values;
      calls.push(sql);
      if (sql.includes("to_regclass")) return [{ ready: true }];
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("FROM person_merge_operations")) return structuredClone(operations.filter(o => o.id === values[0]));
      if (sql.includes("SELECT canonical_id FROM")) {
        const groups = new Set(members.filter(m => values.includes(m.personId)).map(m => m.canonicalId));
        return structuredClone(members.filter(m => groups.has(m.canonicalId) || values.includes(m.personId)));
      }
      return structuredClone(members.filter(m => values.includes(m.personId) || (sql.includes("WHERE canonical_id IN") && values.includes(m.canonicalId))));
    },
    $executeRaw: async (query: any, ...args: any[]) => {
      const sql = Array.isArray(query) ? query.join("?") : query.sql;
      const values = Array.isArray(query) ? args : query.values;
      calls.push(sql);
      if (sql.includes("INSERT INTO person_merge_members")) {
        for (let i = 0; i < values.length; i += 2) { members = members.filter(m => m.personId !== values[i]); members.push({ personId: values[i], canonicalId: values[i + 1] }); }
      } else if (sql.includes("DELETE FROM person_merge_members")) members = members.filter(m => !values.includes(m.personId));
      else if (sql.includes("INSERT INTO person_merge_operations")) operations.push({ id: values[0], before: JSON.parse(values[1]), after: JSON.parse(values[2]), undoneAt: null });
      else if (sql.includes("UPDATE person_merge_operations")) operations.find(o => o.id === values[0])!.undoneAt = new Date();
      return 1;
    },
    $transaction: async (action: (tx: any) => Promise<any>) => {
      const beforeMembers = structuredClone(members), beforeOps = structuredClone(operations);
      try { return await action(db); } catch (error) { members = beforeMembers; operations = beforeOps; throw error; }
    },
  };
  return { db, calls, members: () => structuredClone(members), operations: () => structuredClone(operations) };
}
test("merge links original profiles, expands either identity, and undo restores originals", async () => {
  const ctx = database();
  const merged = await mergePeople("a", "b", "a", ctx.db);
  assert.deepEqual(new Set(await linkedPersonIds(ctx.db, ["b"])), new Set(["a", "b"]));
  assert.deepEqual(ctx.members().map(m => m.canonicalId), ["a", "a"]);
  assert.equal(ctx.operations().length, 1);
  await undoMerge(merged.id, ctx.db);
  assert.deepEqual(ctx.members(), []);
  assert.deepEqual(await linkedPersonIds(ctx.db, ["b"]), ["b"]);
  assert.ok(ctx.calls.some(c => c.includes("pg_advisory_xact_lock")));
  assert.ok(!ctx.calls.some(c => /UPDATE luma_|DELETE FROM luma_/.test(c)));
});
test("chained merges preserve groups; stale undo is rejected and reverse-order undo works", async () => {
  const ctx = database();
  const first = await mergePeople("a", "b", "a", ctx.db);
  const second = await mergePeople("b", "c", "c", ctx.db, ["a", "b", "c"]);
  assert.equal(ctx.members().length, 3);
  await assert.rejects(undoMerge(first.id, ctx.db), /newer merges first/);
  assert.equal(ctx.members().length, 3);
  await undoMerge(second.id, ctx.db);
  assert.deepEqual(new Set(await linkedPersonIds(ctx.db, ["b"])), new Set(["a", "b"]));
  await undoMerge(first.id, ctx.db);
  assert.deepEqual(ctx.members(), []);
});
test("invalid merges never alter identity links", async () => {
  const ctx = database();
  await assert.rejects(mergePeople("a", "a", "a", ctx.db), /distinct/);
  await assert.rejects(mergePeople("a", "b", "other", ctx.db), /primary/);
  await assert.rejects(mergePeople("a", "missing", "a", ctx.db), /no longer exists/);
  assert.deepEqual(ctx.members(), []);
  await mergePeople("a", "b", "a", ctx.db);
  await assert.rejects(mergePeople("a", "b", "a", ctx.db), /already merged/);
});
test("missing migration disables linking and permits legacy history reads", async () => {
  const db: any = { $queryRaw: async () => [{ ready: false }] };
  assert.deepEqual(await linkedPersonIds(db, ["a"]), ["a"]);
  await assert.rejects(mergePeople("a", "b", "a", db), /migration/);
});
test("all merge endpoints reject unauthenticated access before any database operation", async () => {
  const old = process.env.GUESTBOOK_KEY; process.env.GUESTBOOK_KEY = "test-key";
  try {
    for (const [method, handler] of [["GET", GET], ["POST", POST], ["DELETE", DELETE]] as const) {
      assert.equal((await handler(new Request("https://guestbook.test/api/people/merge", { method }))).status, 401);
    }
  } finally { if (old === undefined) delete process.env.GUESTBOOK_KEY; else process.env.GUESTBOOK_KEY = old; }
});

test("merges reject a stale preview instead of silently including unreviewed accounts", async () => {
  const ctx = database();
  await mergePeople("a", "b", "a", ctx.db);
  await assert.rejects(mergePeople("b", "c", "b", ctx.db, ["b", "c"]), /changed/);
  assert.equal(ctx.members().length, 2);
});

test("merged event-count join expands by canonical identity and binds IDs as parameters", async () => {
  const { mergedHistoryJoin } = await import("./merge-identity");
  const ready = { $queryRaw: async () => [{ ready: true }] };
  const sql = await mergedHistoryJoin(ready, ["a", "b"]);
  assert.match(sql.sql, /member.canonical_id = target.canonical_id/);
  assert.match(sql.sql, /identity.source_id = guest.person_id/);
  assert.deepEqual(sql.values, [["a", "b"]]);
  const fallback = await mergedHistoryJoin({ $queryRaw: async () => [{ ready: false }] }, ["a"]);
  assert.ok(!fallback.sql.includes("person_merge_members"));
});

test("candidate review works before migration, without querying missing merge tables", async () => {
  const { station } = await import("../people/merge/store");
  const db: any = { $queryRaw: async (query: any) => {
    assert.match(query.join(""), /to_regclass/); return [{ ready: false }];
  }, lumaPerson: { findMany: async () => ["a", "b"].map(personId => ({
    personId, name: "Jane Smith", email: `${personId}@example.test`, phoneNumber: null, socialLinks: [], tags: [],
    eventGuests: [], _count: { eventGuests: 0 },
  })) } };
  const result = await station(db);
  assert.equal(result.mergeEnabled, false); assert.equal(result.candidates.length, 1);
  assert.equal((result.profiles[0] as any).registrations, undefined);
  assert.equal((result.profiles[0] as any).eventGuests, undefined);
});
