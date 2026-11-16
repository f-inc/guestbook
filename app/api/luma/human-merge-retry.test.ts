import assert from "node:assert/strict";
import test from "node:test";
import { mergeHumans, undoHumanMerge } from "../people/merge/humans";
function replayDb(undoneAt: Date | null = null) {
  const operation = { id: "receipt", before: {primary:{personId:"human_a"},secondary:"human_b"}, after: {}, undoneAt };
  let lookups=0, locks=0;
  const db:any={guestbookHumanMerge:{findUnique:async()=>{lookups++;return operation;}},$executeRaw:async()=>{locks++;},$transaction:async(run:any)=>run(db)};
  return {db,operation,counts:()=>({lookups,locks})};
}
test("human merge retries recover a committed receipt before resolving retired human IDs", async()=>{
  const ctx=replayDb();
  const result=await mergeHumans(ctx.db,"human_a","human_b","human_a",["human_a","human_b"],"receipt");
  assert.equal(result.id,"receipt");assert.equal(result.replayed,true);assert.equal(result.undone,false);
  assert.deepEqual(ctx.counts(),{lookups:1,locks:1});
});
test("an operation ID cannot be reused for a different pair, primary, or reviewed set",async()=>{
  const {db}=replayDb();
  await assert.rejects(mergeHumans(db,"human_a","human_c","human_a",["human_a","human_c"],"receipt"),/different merge/);
  await assert.rejects(mergeHumans(db,"human_a","human_b","human_b",["human_a","human_b"],"receipt"),/different merge/);
  await assert.rejects(mergeHumans(db,"human_a","human_b","human_a",["human_a"],"receipt"),/different merge/);
});
test("a retried merge that was already undone never merges the people again",async()=>{
  const {db}=replayDb(new Date());
  const result=await mergeHumans(db,"human_b","human_a","human_a",["human_b","human_a"],"receipt");assert.equal(result.undone,true);
});
test("a lost Undo response can be retried without repeating any identity mutations",async()=>{
  const {db}=replayDb(new Date());const result=await undoHumanMerge(db,"receipt");assert.equal(result.undone,true);assert.equal(result.replayed,true);
});
