import assert from "node:assert/strict";
import { test } from "node:test";
import { humanClient } from "./human-mode";
import { readIndexedSnapshot } from "./read-snapshot";

test("read snapshots retain human routing and isolation without waiting on the writer lock", async t => {
  const previous = process.env.GUESTBOOK_IDENTITY_MODE;
  process.env.GUESTBOOK_IDENTITY_MODE = "human";
  t.after(() => { if (previous === undefined) delete process.env.GUESTBOOK_IDENTITY_MODE; else process.env.GUESTBOOK_IDENTITY_MODE = previous; });
  const statements: string[] = [];
  const tx = { $executeRaw: async (sql: any) => { statements.push(sql.join ? sql.join("") : sql.strings.join("")); return 0; }, guestbookEventGuest: { findMany: async () => ["indexed-row"] } };
  const source: any = { $transaction: async (read: any, options: any) => { assert.deepEqual(options, {isolationLevel:"RepeatableRead",maxWait:5000,timeout:15000}); return read(tx); } };
  const result = await readIndexedSnapshot(humanClient(source), async db => db.lumaEventGuest.findMany());
  assert.deepEqual(result, ["indexed-row"]);
  assert.deepEqual(statements, ["SET TRANSACTION READ ONLY"]);
  assert(!statements.some(sql => sql.includes("advisory")));
});
