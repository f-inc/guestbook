import assert from "node:assert/strict";
import test from "node:test";
import { MergeQueue, holdsProfiles, isOutstanding, type MergeJob } from "../../merge/merge-queue";
const job = (id: string, left = `${id}-a`, right = `${id}-b`) => ({ id, left, right, primary: left, reviewedPersonIds: [left, right], createdAt: new Date().toISOString() });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (result: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return { promise, resolve, reject }; }
function setup(overrides: any = {}, restored: MergeJob[] = []) {
  let published: MergeJob[] = [], persisted: MergeJob[] = [];
  const calls: string[] = [];
  let time = 0, nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const advance = async (milliseconds: number) => {
    time += milliseconds;
    for (;;) {
      const due = [...timers].find(([, timer]) => timer.at <= time);
      if (!due) break;
      timers.delete(due[0]); due[1].callback(); await tick();
    }
    await tick();
  };
  const queue = new MergeQueue({
    now: () => time,
    schedule: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, {at: time + milliseconds, callback}); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel: timer => { timers.delete(timer as unknown as number); },
    persist: jobs => { persisted = structuredClone(jobs); },
    publish: jobs => { published = jobs; },
    merge: async job => { calls.push(`merge:${job.id}`); return { id: job.id }; },
    undo: async id => { calls.push(`undo:${id}`); },
    ...overrides,
  }, restored);
  queue.start();
  return { queue, calls, advance, published: () => published, persisted: () => persisted };
}
test("review accepts multiple decisions while a save is pending, and cancels an unsent decision", async () => {
  const first = deferred<{id:string}>();
  const sent: string[] = [];
  const ctx = setup({ merge: (job: MergeJob) => { sent.push(job.id); return first.promise; } });
  assert(ctx.queue.enqueue(job("first")));
  assert(ctx.queue.enqueue(job("second")));
  assert.equal(ctx.published().length, 2);
  assert.deepEqual(sent, []);
  ctx.queue.undo("second");
  assert.equal(ctx.published().some(job => job.id === "second"), false);
  assert.deepEqual(ctx.persisted(), []);
  await ctx.advance(5000);
  first.resolve({id:"first"}); await tick();
  assert.deepEqual(sent, ["first"]);
  assert.equal(ctx.published()[0].status, "saved");
});
test("Undo is immediately available during a save and reverses it before the next queued merge", async () => {
  const first = deferred<{id:string}>(), calls: string[] = [];
  const ctx = setup({ merge: (job: MergeJob) => { calls.push(`merge:${job.id}`); return job.id === "first" ? first.promise : Promise.resolve({id:job.id}); }, undo: async (id: string) => {calls.push(`undo:${id}`);} });
  ctx.queue.enqueue(job("first")); ctx.queue.enqueue(job("second"));
  await ctx.advance(5000);
  ctx.queue.undo("first");
  assert.equal(ctx.published()[0].undoRequested, true);
  first.resolve({id:"first"}); await tick();
  assert.deepEqual(calls, ["merge:first", "undo:first", "merge:second"]);
  assert.equal(ctx.published()[0].status, "undone");
  assert.equal(ctx.published()[1].status, "saved");
});
test("a rejected merge restores only its profiles and continues other decisions", async () => {
  const ctx = setup({ merge: async (job: MergeJob) => { if(job.id === "bad") throw Object.assign(new Error("Changed"),{status:409}); return {id:job.id}; } });
  ctx.queue.enqueue(job("bad")); ctx.queue.enqueue(job("good")); await ctx.advance(5000);
  assert.equal(ctx.published()[0].status, "failed");
  assert(!holdsProfiles(ctx.published()[0]));
  assert.equal(ctx.published()[1].status, "saved");
});
test("a lost response retains ambiguous work and Undo safely recovers the same operation ID", async () => {
  let attempts = 0; const ids: string[] = [], undone: string[] = [];
  const ctx = setup({ merge: async (job: MergeJob) => { ids.push(job.id); if(!attempts++) throw new Error("Lost response"); return {id:job.id}; }, undo: async (id:string)=>{undone.push(id);} });
  ctx.queue.enqueue(job("retry")); await ctx.advance(5000);
  assert.equal(ctx.published()[0].status, "uncertain"); assert(holdsProfiles(ctx.published()[0]));
  ctx.queue.undo("retry"); await tick();
  assert.deepEqual(ids, ["retry", "retry"]); assert.deepEqual(undone, ["retry"]);
  assert.equal(ctx.published()[0].status, "undone");
});
test("reload resumes an interrupted save with the same receipt ID", async () => {
  const restored: MergeJob = {...job("resumed"),status:"saving",undoRequested:false};
  const ctx=setup({}, [restored]); await tick();
  assert.deepEqual(ctx.calls,["merge:resumed"]); assert.equal(ctx.published()[0].status,"saved");
});
test("reload resumes interrupted Undo without sending another merge", async () => {
  const restored: MergeJob={...job("undo"),status:"undoing",undoRequested:true,phase:"undo"};
  const ctx=setup({},[restored]); await tick();
  assert.deepEqual(ctx.calls,["undo:undo"]); assert.equal(ctx.published()[0].status,"undone");
});
test("double confirmation and overlapping queued pairs never produce extra writes", async () => {
  const pending=deferred<{id:string}>(); const ctx=setup({merge:()=>pending.promise});
  assert(ctx.queue.enqueue(job("one","a","b")));
  assert.equal(ctx.queue.enqueue(job("two","a","c")),false);
  assert.equal(ctx.queue.enqueue(job("three","b","a")),false);
  await ctx.advance(5000);pending.resolve({id:"one"});await tick();assert.equal(ctx.published().length,1);
});
test("storage failure at the deadline prevents sending an unpersisted merge", async () => {
  let reject=false; const ctx=setup({persist:()=>{if(reject)throw new Error("Full");}});reject=true;
  ctx.queue.enqueue(job("lost")); await ctx.advance(5000);
  assert.deepEqual(ctx.calls,[]);assert.equal(ctx.published()[0].status,"uncertain");
});
test("completed history is bounded in storage without resurrecting cards in the current session", async () => {
  const restored=Array.from({length:110},(_,i)=>({...job(String(i)),status:"saved" as const,undoRequested:false}));
  const ctx=setup({},restored);assert.equal(ctx.persisted().length,100);assert.equal(ctx.published().length,110);
});
test("failed Undo retains the saved merge and reports its failure", async () => {
  const ctx=setup({undo:async()=>{throw Object.assign(new Error("Undo newer merges first"),{status:409});}});
  ctx.queue.enqueue(job("saved"));await ctx.advance(5000);ctx.queue.undo("saved");await tick();
  const result=ctx.published()[0];assert.equal(result.status,"saved");assert(result.error);assert(holdsProfiles(result));assert(!isOutstanding(result));
});
test("a stopped page cannot overwrite the resumed page after an old request finishes", async () => {
  const pending=deferred<{id:string}>();const ctx=setup({merge:()=>pending.promise});
  ctx.queue.enqueue(job("old"));await ctx.advance(5000);ctx.queue.stop();const saved=ctx.persisted();
  pending.resolve({id:"old"});await tick();assert.deepEqual(ctx.persisted(),saved);
});

test("nothing starts or is persisted before five seconds; Undo erases the draft entirely", async () => {
  let writes=0;
  const ctx=setup({persist:()=>{writes++;}});const baseline=writes;
  ctx.queue.enqueue(job("draft"));await ctx.advance(4999);
  assert.deepEqual(ctx.calls,[]);assert.equal(writes,baseline);
  assert.equal(ctx.published()[0].status,"waiting");
  ctx.queue.undo("draft");assert.deepEqual(ctx.published(),[]);assert.equal(writes,baseline);
  await ctx.advance(10000);assert.deepEqual(ctx.calls,[]);assert.deepEqual(ctx.queue.snapshot(),[]);
});
test("an uncancelled confirmation starts only at the five-second boundary", async () => {
  const ctx=setup();ctx.queue.enqueue(job("five"));await ctx.advance(4999);assert.deepEqual(ctx.calls,[]);
  await ctx.advance(1);assert.deepEqual(ctx.calls,["merge:five"]);assert.equal(ctx.published()[0].status,"saved");
});
test("each rapid confirmation has its own complete undo window", async () => {
  const ctx=setup();ctx.queue.enqueue(job("first"));await ctx.advance(3000);ctx.queue.enqueue(job("second"));
  await ctx.advance(2000);assert.deepEqual(ctx.calls,["merge:first"]);
  ctx.queue.undo("second");await ctx.advance(5000);assert.deepEqual(ctx.calls,["merge:first"]);
  assert.equal(ctx.published().some(job=>job.id==="second"),false);
});
test("leaving during the grace period discards confirmations without persisting or sending them", async () => {
  const ctx=setup();ctx.queue.enqueue(job("leave"));ctx.queue.stop();await ctx.advance(10000);
  assert.deepEqual(ctx.calls,[]);assert.deepEqual(ctx.persisted(),[]);assert.deepEqual(ctx.queue.snapshot(),[]);
});
