import test from "node:test";
import assert from "node:assert/strict";
import { emailableRequest, normalizeVerification, parseVerificationBatch } from "./emailable-client";
import { runVerificationTick } from "./email-verification";

test("verification preserves uncertainty and does not invent bounce evidence", () => {
  const row = normalizeVerification({ email: " Test@Example.com ", state: "risky", reason: "low_deliverability", accept_all: true, score: 45 });
  assert.equal(row.emailLower, "test@example.com");
  assert.equal(row.state, "risky");
  assert.equal(row.flags.acceptAll, true);
  assert.equal("bouncedAt" in row, false);
  assert.equal(normalizeVerification({ email: "a@b.co", state: "unknown" }).state, "unknown");
  assert.throws(() => normalizeVerification({ email: "a@b.co", state: "bounced" }));
});
test("completed batches require exact, distinct recipient coverage", () => {
  const result = { email: "a@b.co", state: "deliverable" };
  assert.equal(parseVerificationBatch({ emails: [result], message: "Your batch is being processed." }, ["a@b.co", "c@d.co"]).complete, false);
  assert.throws(() => parseVerificationBatch({ emails: [result], message: "Batch verification completed." }, ["a@b.co", "c@d.co"]));
  assert.throws(() => parseVerificationBatch({ emails: [result, result] }, ["a@b.co"]));
  assert.throws(() => parseVerificationBatch({ emails: [result] }, ["someone@else.co"]));
  assert.equal(parseVerificationBatch({ emails: [result], message: "Batch verification completed." }, ["a@b.co"]).complete, true);
});
test("credentials use headers, not URLs, and provider bodies stay out of errors", async () => {
  const previous = process.env.EMAILABLE_API_KEY;
  process.env.EMAILABLE_API_KEY = "test-secret";
  try {
    await assert.rejects(emailableRequest("GET", { id: "batch-one" }, (async (url, options) => {
      assert.equal(String(url).includes("test-secret"), false);
      assert.equal(options?.headers?.["Authorization"], "Bearer test-secret");
      return new Response('{"message":"test-secret"}', { status: 402 });
    }) as typeof fetch), (error: any) => error.definitive && !error.message.includes("test-secret"));
  } finally {
    if (previous === undefined) delete process.env.EMAILABLE_API_KEY;
    else process.env.EMAILABLE_API_KEY = previous;
  }
});
const runVerificationTickWithCredits = (db: any, request: any) => runVerificationTick(db, request, async () => 1000);
function workerDb(batch: any, claimed = 1) {
  const updates: any[] = [];
  return { updates, db: {
    emailVerificationRun: {
      findFirst: async () => ({ id: "run", total: 1 }),
      updateMany: async (arg: any) => { updates.push(arg.data); return { count: claimed }; },
      update: async (arg: any) => { updates.push(arg.data); },
    },
    emailVerificationBatch: {
      findFirst: async () => batch,
      create: async () => ({ id: "batch", emails: ["a@b.co"] }),
      update: async (arg: any) => { updates.push(arg.data); },
    },
    emailAddress: { findMany: async () => [{ emailLower: "a@b.co" }] },
  } as any };
}
test("a second worker cannot submit a batch without the database lease", async () => {
  const { db } = workerDb(null, 0);
  await runVerificationTickWithCredits(db, async () => { assert.fail("must not submit"); });
});
test("interrupted submission is paused for reconciliation, never automatically resubmitted", async () => {
  const { db, updates } = workerDb({ status: "submitting" });
  await runVerificationTickWithCredits(db, async () => { assert.fail("must not resubmit"); });
  assert.ok(updates.some((u) => u.status === "submission_unknown"));
});
test("ambiguous provider timeout preserves submission intent", async () => {
  const { db, updates } = workerDb(null);
  await runVerificationTickWithCredits(db, async () => { throw new Error("timeout"); });
  assert.ok(updates.some((u) => u.status === "submission_unknown"));
  assert.equal(updates.some((u) => u.status === "rejected"), false);
});
test("definitive rejection can resume without duplicating an accepted batch", async () => {
  const { db, updates } = workerDb(null);
  await runVerificationTickWithCredits(db, async () => { throw Object.assign(new Error("credits"), { definitive: true }); });
  assert.ok(updates.some((u) => u.status === "rejected"));
  assert.ok(updates.some((u) => u.status === "paused"));
});

test("partial results are persisted without finishing or resubmitting the batch", async () => {
  const { db, updates } = workerDb({ id: "batch", status: "waiting", providerId: "remote", emails: ["a@b.co", "c@d.co"] });
  let writes = 0;
  db.$transaction = async (callback: any) => callback({ emailVerificationCheck: {createMany: async () => {}}, $executeRaw: async () => { writes++; } });
  await runVerificationTickWithCredits(db, async (method, batch) => {
    assert.equal(method, "GET");
    assert.deepEqual(batch, { id: "remote" });
    return { message: "Your batch is being processed.", emails: [{ email: "a@b.co", state: "risky" }] };
  });
  assert.equal(writes, 1);
  assert.equal(updates.some((u) => u.status === "completed" || u.status === "paused"), false);
});
test("completed results clear the queue and increment progress atomically", async () => {
  const { db, updates } = workerDb({ id: "batch", status: "waiting", providerId: "remote", emails: ["a@b.co"] });
  let clear: any;
  db.$transaction = async (callback: any) => callback({
    emailVerificationCheck: {createMany: async () => {}},
    $executeRaw: async () => {},
    emailAddress: { updateMany: async (q: any) => { clear = q; } },
    emailVerificationBatch: db.emailVerificationBatch,
    emailVerificationRun: db.emailVerificationRun,
  });
  await runVerificationTickWithCredits(db, async () => ({ message: "Batch verification completed.", emails: [{ email: "a@b.co", state: "undeliverable" }] }));
  assert.equal(clear.where.queuedRunId, "run");
  assert.equal(clear.data.queuedRunId, null);
  assert.ok(updates.some((u) => u.status === "completed"));
  assert.ok(updates.some((u) => u.processed?.increment === 1));
});

test("credit balance accepts zero but rejects missing, fractional and negative balances", async () => {
  const { emailableCredits, verificationBudget } = await import("./emailable-client");
  const old = process.env.EMAILABLE_API_KEY;
  process.env.EMAILABLE_API_KEY = "test-key";
  try {
    for (const available_credits of [0, 4990]) {
      assert.equal(await emailableCredits((async (url, options) => {
        assert.equal(url, "https://api.emailable.com/v1/account");
        assert.equal((options?.headers as any).Authorization, "Bearer test-key");
        return Response.json({ available_credits, owner_email: "private@example.com" });
      }) as typeof fetch), available_credits);
    }
    for (const value of [undefined, -1, 1.5, "5000"]) {
      await assert.rejects(emailableCredits((async () => Response.json({available_credits: value})) as typeof fetch));
    }
    assert.equal(verificationBudget(4990, 40000), 4990);
    assert.equal(verificationBudget(4990, 10), 10);
    assert.equal(verificationBudget(0, 10), 0);
  } finally {
    if (old === undefined) delete process.env.EMAILABLE_API_KEY;
    else process.env.EMAILABLE_API_KEY = old;
  }
});

test("worker pauses without submitting when balance reaches zero", async () => {
  const {db, updates} = workerDb(null);
  await runVerificationTick(db, async () => { assert.fail("no paid submission"); }, async () => 0);
  assert.ok(updates.some(u => u.status === "paused" && u.error.includes("credits")));
  assert.equal(updates.some(u => u.status === "submission_unknown"), false);
});

test("worker limits new batches to the fresh balance", async () => {
  const {db} = workerDb(null);
  db.emailAddress.findMany = async () => [{emailLower:"a@b.co"},{emailLower:"c@d.co"}];
  db.emailVerificationBatch.create = async ({data}: any) => {
    assert.deepEqual(data.emails, ["a@b.co"]);
    return data;
  };
  await runVerificationTick(db, async (method, batch) => {
    assert.equal(method,"POST");
    assert.deepEqual(batch, {emails:["a@b.co"]});
    return {id:"remote"};
  }, async () => 1);
});

test("unavailable credits fail closed before paid submission", async () => {
  const {db, updates} = workerDb(null);
  await runVerificationTick(db, async () => { assert.fail("no paid submission"); }, async () => { throw new Error("offline"); });
  assert.ok(updates.some(u => u.status === "paused"));
});

test("starting a scan binds the smaller displayed and live budgets into the database limit", async () => {
  const {startVerification} = await import("./email-verification");
  const old = process.env.EMAILABLE_API_KEY;
  process.env.EMAILABLE_API_KEY = "test-key";
  try {
    let queueQuery: any;
    const tx: any = {
      $queryRaw: async () => [],
      $executeRaw: async (query: any) => { if(query.sql.includes("candidates AS")) {queueQuery=query;return 7;} return 0; },
      emailVerificationRun: {findFirst:async()=>null,create:async ({data}: any)=>data},
    };
    const db: any = {$transaction:async (fn: any)=>fn(tx)};
    assert.equal((await startVerification(10,db,async()=>7)).total,7);
    assert.ok(queueQuery.values.includes(7));
    assert.match(queueQuery.sql,/LIMIT \?/);
    await assert.rejects(startVerification(10,db,async()=>0),/No Emailable credits/);
  } finally {
    if(old === undefined) delete process.env.EMAILABLE_API_KEY; else process.env.EMAILABLE_API_KEY=old;
  }
});

test("new Luma restriction after queueing skips verification without spending credits", async () => {
  const { db, updates } = workerDb(null);
  let cleared = false;
  db.emailAddress.findMany = async () => [{emailLower:"a@b.co", lumaBlockedReason:"bounced"}];
  db.emailAddress.updateMany = async ({data}:any) => { cleared = data.queuedRunId === null; };
  db.$transaction = async (callback:any) => callback(db);
  await runVerificationTick(db, async () => { assert.fail("blocked address must not reach provider"); }, async () => { assert.fail("no need to query credits"); });
  assert.ok(cleared);
  assert.ok(updates.some(u => u.skipped?.increment === 1));
});

test("repeated partial polling keeps one history identity; a later check has another", async () => {
  const batch = { id:"batch",status:"waiting",providerId:"remote",emails:["a@b.co"] };
  const {db} = workerDb(batch);
  const ids = new Set<string>();
  db.$transaction = async (callback:any) => callback({
    emailVerificationCheck: { createMany:async (q:any) => { assert.equal(q.skipDuplicates,true); q.data.forEach(r=>ids.add(r.id)); } },
    $executeRaw:async()=>{},
  });
  const response = async () => ({message:"Processing", emails:[{email:"a@b.co",state:"risky",accept_all:true}]});
  await runVerificationTickWithCredits(db,response);
  await runVerificationTickWithCredits(db,response);
  assert.equal(ids.size,1);
  batch.id="later-batch";
  await runVerificationTickWithCredits(db,response);
  assert.equal(ids.size,2);
});
