import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { runCioProjectionBatch, seedCioQueue, loadCioProjection } from "./cio-sync";
import { completeCioSourceSnapshot } from "./cio-source";

// This is a real PostgreSQL engine entirely in process. No application DB_URL,
// network socket or shared database is ever opened by these write-capable tests.
let pg: PGlite;
const email="builder@example.com";
const savedEnv = { ...process.env };
before(async()=>{
  const directory=mkdtempSync(join(tmpdir(),"guestbook-cio-schema-"));
  try {
    const schema=readFileSync("prisma/schema.prisma","utf8").replace(/^model Cio(?:ProjectionQueue|SyncControl) \{[\s\S]*?^\}\n/gm,"");
    const path=join(directory,"schema.prisma"); writeFileSync(path,schema);
    const sql=execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","diff","--from-empty","--to-schema-datamodel",path,"--script"],
      {encoding:"utf8",env:{...process.env,DB_URL:"postgresql://unused:unused@127.0.0.1:1/unused"}});
    pg=new PGlite();
    await pg.exec(sql);
    await pg.exec(`INSERT INTO guest_tags(id,name,color,updated_at) VALUES('blacklist-test','☠️ Blacklist','#000000',now()),('no-invite-test','✉️ No Invite','#000000',now());`);
    await pg.exec(readFileSync("prisma/manual-migrations/20261022_cio_projection.sql","utf8"));
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
after(async()=>{await pg?.close();for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);});
beforeEach(async()=>{
  await pg.exec(`TRUNCATE luma_events, luma_people, cio_projection_queue, cio_sync_control, luma_calendar_opt_outs, email_addresses, email_inactive CASCADE;
    INSERT INTO luma_events(event_id,title) VALUES('evt-1','Test');
    INSERT INTO luma_people(person_id,name,email_lower) VALUES('usr-1','Builder','${email}');
    DELETE FROM cio_projection_queue;`);
  Object.assign(process.env,{NODE_ENV:"production",GUESTBOOK_ENVIRONMENT:"production",CIO_SYNC_ENABLED:"true",CIO_SYNC_SEND_ENABLED:"true",
    CIO_SYNC_IDENTITY_CONFIRMED:"email_lookup",CUSTOMERIO_APP_API_KEY:"app-test",CIO_SYNC_PROFILE_MODE:"existing_only",CIO_SYNC_AUTOMATIONS_REVIEWED:"true",CIO_SYNC_ALLOWED_EMAILS:email,CUSTOMERIO_SITE_ID:"test",CUSTOMERIO_TRACK_API_KEY:"test"});
  delete process.env.VERCEL_ENV; delete process.env.CIO_SYNC_FULL_ROLLOUT;
});
async function insertGuest(){await pg.query(`INSERT INTO luma_event_guests(event_id,person_id,email_lower,luma_approval_status,registered_at) VALUES('evt-1','usr-1',$1,'approved',now())`,[email]);}
async function queue(){return (await pg.query<any>("SELECT * FROM cio_projection_queue WHERE email=$1",[email])).rows[0];}
async function mark(){await pg.query("SELECT cio_mark_email($1)",[email]);}
function adapter() {
  return {
    ...seedAdapter(),
    $queryRawUnsafe:async(sql,...params)=>(await pg.query(sql,params)).rows,
    $executeRawUnsafe:async(sql,...params)=>(await pg.query(sql,params)).affectedRows,
    cioProjectionQueue:{findUnique:async({where})=>{const row=(await pg.query<any>("SELECT * FROM cio_projection_queue WHERE email=$1",[where.email])).rows[0];return row&&{revision:row.revision,leaseToken:row.lease_token,answerState:row.answer_state};}},
    lumaPerson:{findMany:async({where})=>(await pg.query<any>('SELECT person_id AS "personId", email_lower AS "emailLower", tags FROM luma_people WHERE email_lower=$1',[where.emailLower])).rows},
    guestTag:{findMany:async()=>(await pg.query<any>(`SELECT name, semantic_key AS "semanticKey" FROM guest_tags WHERE semantic_key IN ('cio_blacklist','cio_no_invite')`)).rows},
    lumaEventGuest:{findFirst:async()=>null,findMany:async({where})=>{
      const result=await pg.query<any>(`SELECT * FROM luma_event_guests WHERE email_lower=$1`,[where.emailLower]);
      return result.rows.map(r=>({eventId:r.event_id,personId:r.person_id,emailLower:r.email_lower,lumaApprovalStatus:r.luma_approval_status,
        registeredAt:r.registered_at,checkedInAt:r.checked_in_at,syncedAt:r.synced_at,lastSeenAt:r.last_seen_at,raw:r.raw,registrationAnswers:r.registration_answers,person:{emailLower:r.email_lower},
        event:{title:"Test",raw:{},syncState:{lastGuestSyncAt:new Date(),lastStatus:"success",truncated:false}}}));
    }},
    lumaCalendarOptOut:{findMany:async()=>[]},emailAddress:{findUnique:async()=>null},emailInactive:{findUnique:async()=>null},
  } as any;
}

test("migration pins the existing exclusion definitions without changing display labels", async()=>{
  const definitions=(await pg.query<any>("SELECT name, semantic_key FROM guest_tags ORDER BY id")).rows;
  assert.deepEqual(definitions,[{name:"☠️ Blacklist",semantic_key:"cio_blacklist"},{name:"✉️ No Invite",semantic_key:"cio_no_invite"}]);
});

test("adding and removing a person tag queues urgent updates, including tag-only people", async()=>{
  await pg.exec(`UPDATE luma_people SET tags='["☠️ Blacklist"]'`);
  const first=await queue(); assert.ok(first); assert.equal(first.priority,1);
  const projection=await loadCioProjection(email,adapter()); assert.equal(projection.attrs.finc_luma_blacklisted,true);
  let sent:any;
  await runCioProjectionBatch({db:adapter(),fetchImpl:withProfileLookup(async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response("",{status:200});})});
  assert.equal(sent.finc_luma_blacklisted,true);assert.equal(sent.finc_luma_registration_count,0);
  await pg.exec(`UPDATE luma_people SET tags='[]'`);
  assert.ok((await queue()).revision>first.revision);
  await runCioProjectionBatch({db:adapter(),fetchImpl:withProfileLookup(async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response("",{status:200});})});
  assert.equal(sent.finc_luma_blacklisted,false);
});
test("answer state commits only after delivery and protects against an older source replay", async()=>{
  await insertGuest();
  const raw=(value,date)=>JSON.stringify({registered_at:date,registration_answers:[{label:"Company",value}]});
  await pg.query("UPDATE luma_event_guests SET raw=$1",[raw("Current","2026-01-01T00:00:00Z")]);
  const db=adapter();
  await runCioProjectionBatch({db,fetchImpl:withProfileLookup(async()=>new Response("",{status:503}))});
  assert.deepEqual((await queue()).answer_state,{});
  await mark();await runCioProjectionBatch({db,fetchImpl:withProfileLookup(async()=>new Response("",{status:200}))});
  assert.equal((await queue()).answer_state.company.value,"Current");
  await pg.query("UPDATE luma_event_guests SET raw=$1",[raw("Old","2025-01-01T00:00:00Z")]);
  const projection=await loadCioProjection(email,db);
  assert.equal((projection.attrs as Record<string,unknown>).finc_luma_profile_company,"Current");
  assert.deepEqual(projection.olderAnswersIgnored,["company"]);
});

test("source update and queued revision commit or roll back together",async()=>{
  await insertGuest();const first=await queue();assert.equal(String(first.revision),"1");
  await pg.exec("BEGIN; UPDATE luma_event_guests SET luma_approval_status='declined'; ROLLBACK;");
  assert.equal((await queue()).revision,first.revision);
  await pg.exec("UPDATE luma_event_guests SET luma_approval_status='declined';");
  assert.ok((await queue()).revision>first.revision);
});
test("timestamp-only polling does not enqueue duplicates; deleting a guest does",async()=>{
  await insertGuest();const revision=(await queue()).revision;
  await pg.exec("UPDATE luma_event_guests SET synced_at=now(),last_seen_at=now();");
  assert.equal((await queue()).revision,revision);
  await pg.exec("DELETE FROM luma_event_guests;");assert.ok((await queue()).revision>revision);
});
test("event cancellation, scoped opt-out and address restriction all enqueue affected people",async()=>{
  await insertGuest();let revision=(await queue()).revision;
  await pg.exec(`UPDATE luma_events SET raw='{"status":"canceled"}'`);
  assert.ok((await queue()).revision>revision);revision=(await queue()).revision;
  await pg.query(`INSERT INTO luma_calendar_opt_outs("calendarId","emailLower") VALUES('cal-1',$1)`,[email]);
  assert.ok((await queue()).revision>revision);revision=(await queue()).revision;
  await pg.query(`INSERT INTO email_addresses("emailLower",state) VALUES($1,'undeliverable')`,[email]);
  assert.ok((await queue()).revision>revision);
});
test("changing an email enqueues both addresses instead of silently migrating identity",async()=>{
  await insertGuest();await pg.exec(`UPDATE luma_event_guests SET email_lower='new@example.com';`);
  const rows=(await pg.query<any>("SELECT email FROM cio_projection_queue ORDER BY email")).rows;
  assert.deepEqual(rows.map(r=>r.email),[email,"new@example.com"]);
});
test("successful batch is idempotent and duplicate scheduler calls cannot resend unchanged data",async()=>{
  await insertGuest();let sends=0;const mock:typeof fetch=async()=>{sends++;return new Response("",{status:200});};
  const db=adapter();await runCioProjectionBatch({db,fetchImpl:withProfileLookup(mock)});
  assert.equal(sends,1);assert.equal((await queue()).sent_revision,(await queue()).revision);
  await mark();await runCioProjectionBatch({db,fetchImpl:withProfileLookup(mock)});assert.equal(sends,1);
});
test("an update during delivery survives acknowledgement and is sent next",async()=>{
  await insertGuest();let sends=0;
  const mock:typeof fetch=async()=>{sends++;if(sends===1)await pg.exec("UPDATE luma_event_guests SET luma_approval_status='declined';");return new Response("",{status:200});};
  const db=adapter();await runCioProjectionBatch({db,fetchImpl:withProfileLookup(mock),maxItems:1});
  assert.ok((await queue()).revision>(await queue()).sent_revision);
  await runCioProjectionBatch({db,fetchImpl:withProfileLookup(mock),maxItems:1});assert.equal(sends,2);
  assert.equal((await queue()).revision,(await queue()).sent_revision);
});
test("outage leaves durable work pending; restart retries the same projection",async()=>{
  await insertGuest();const db=adapter();
  await runCioProjectionBatch({db,fetchImpl:async()=>{throw new Error("network timeout")}});
  const failed=await queue();assert.equal(String(failed.sent_revision),"0");assert.equal(failed.attempts,1);assert.equal(failed.lease_token,null);
  await pg.exec("UPDATE cio_projection_queue SET next_attempt_at=now();");
  await runCioProjectionBatch({db,fetchImpl:withProfileLookup(async()=>new Response("",{status:200}))});
  assert.equal((await queue()).revision,(await queue()).sent_revision);
});
test("rate limit pauses the workspace; authentication failure requires review without response-body leakage",async()=>{
  await insertGuest();const db=adapter();const before=Date.now();
  await runCioProjectionBatch({db,fetchImpl:async()=>new Response("private",{status:429,headers:{"retry-after":"120"}})});
  assert.ok(new Date((await queue()).next_attempt_at).getTime()>=before+119_000);
  await mark();
  let sends=0;
  const paused=await runCioProjectionBatch({db,fetchImpl:async()=>{sends++;return new Response("",{status:200})}});
  assert.equal(paused.processed,0); assert.equal(sends,0);
  await pg.exec("UPDATE cio_sync_control SET data='{}' WHERE id='delivery'");
  await pg.exec("UPDATE cio_projection_queue SET next_attempt_at=now();");
  await runCioProjectionBatch({db,fetchImpl:async()=>new Response("private",{status:401})});
  assert.equal((await queue()).attempts,1);assert.equal((await queue()).last_error,"cio_http_401");
  await mark();
  await runCioProjectionBatch({db,fetchImpl:async()=>{sends++;return new Response("",{status:200})}});
  assert.equal(sends,0);
  assert.equal((await pg.query<any>("SELECT data FROM cio_sync_control WHERE id='delivery'")).rows[0].data.requiresReview,true);
});
test("expired process lease is reclaimable while active lease is respected",async()=>{
  await insertGuest();let sends=0;const db=adapter();const mock:typeof fetch=async()=>{sends++;return new Response("",{status:200});};
  await pg.exec("UPDATE cio_projection_queue SET lease_token='crashed-worker',lease_until=now()+interval '1 minute'");
  await runCioProjectionBatch({db,fetchImpl:withProfileLookup(mock)});assert.equal(sends,0);
  await pg.exec("UPDATE cio_projection_queue SET lease_until=now()-interval '1 second'");
  await runCioProjectionBatch({db,fetchImpl:withProfileLookup(mock)});assert.equal(sends,1);
});

// Minimal Prisma-shaped adapter; cursor and queue writes use the same real
// PostgreSQL transaction, including an injected failure at cursor persistence.
function seedAdapter(sql: any = pg, failCursor = false): any {
  return {
    $queryRawUnsafe: async (query, ...params) => (await sql.query(query, params)).rows,
    $transaction: callback => pg.transaction(tx => callback(seedAdapter(tx, failCursor))),
    cioSyncControl: {
      upsert: async ({ where, create, update }) => create?.data || update?.data
        ? sql.query("INSERT INTO cio_sync_control(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [where.id,JSON.stringify(update?.data || create.data)])
        : sql.query("INSERT INTO cio_sync_control(id) VALUES($1) ON CONFLICT DO NOTHING", [where.id]),
      findUnique: async ({ where }) => (await sql.query("SELECT id,data FROM cio_sync_control WHERE id=$1", [where.id])).rows[0],
      findMany: async ({ where }) => (await sql.query("SELECT id,data FROM cio_sync_control WHERE id=ANY($1::text[])", [where.id.in])).rows,
      update: async ({ where, data }) => {
        if (failCursor) throw new Error("cursor_write_failed");
        await sql.query("UPDATE cio_sync_control SET data=$2::jsonb WHERE id=$1", [where.id, JSON.stringify(data.data)]);
      },
      updateMany: async ({ where, data }) => {
        const result = where.owner
          ? await sql.query("UPDATE cio_sync_control SET owner=NULL,lease_until=NULL WHERE id=$1 AND owner=$2", [where.id, where.owner])
          : await sql.query("UPDATE cio_sync_control SET owner=$2,lease_until=$3 WHERE id=$1 AND (lease_until IS NULL OR lease_until<now())", [where.id, data.owner, data.leaseUntil]);
        return { count: result.affectedRows };
      },
    },
  };
}
test("history seed commits its cursor with the queue batch and safely resumes", async () => {
  await insertGuest(); await pg.exec("DELETE FROM cio_projection_queue");
  await assert.rejects(seedCioQueue(1, seedAdapter(pg, true)), /cursor_write_failed/);
  assert.equal(await queue(), undefined);
  const first = await seedCioQueue(1, seedAdapter());
  assert.equal(first.queued, 1); assert.equal(first.complete, false);
  const revision = (await queue()).revision;
  assert.equal((await seedCioQueue(1, seedAdapter())).complete, true);
  assert.equal((await seedCioQueue(1, seedAdapter())).queued, 0);
  assert.equal((await queue()).revision, revision);
});
test("preview deployments cannot seed a shared production database", async () => {
  process.env.VERCEL_ENV = "preview";
  await assert.rejects(seedCioQueue(1, seedAdapter()), /production_identity_required/);
  assert.equal((await pg.query("SELECT * FROM cio_sync_control")).rows.length, 0);
});

test("completed scans correct CIO absence without deleting Guestbook rows, and reappearance requeues", async () => {
  await insertGuest();
  await pg.exec("UPDATE luma_event_guests SET last_seen_at='2026-01-01T00:00:00Z'; DELETE FROM cio_projection_queue;");
  const db=adapter();
  await completeCioSourceSnapshot("evt-1","2026-02-01T00:00:00Z",db);
  assert.equal((await pg.query("SELECT * FROM luma_event_guests")).rows.length,1);
  assert.equal((await loadCioProjection(email,db)).attrs.finc_luma_registration_count,0);
  const revision=(await queue()).revision;
  await pg.exec("UPDATE luma_event_guests SET last_seen_at='2026-03-01T00:00:00Z'");
  assert.ok((await queue()).revision>revision);
  assert.equal((await loadCioProjection(email,db)).attrs.finc_luma_registration_count,1);
  await completeCioSourceSnapshot("evt-1","2026-01-15T00:00:00Z",db);
  const control=(await pg.query<any>("SELECT data FROM cio_sync_control WHERE id='coverage:evt-1'")).rows[0];
  assert.equal(Date.parse(control.data.completedBefore),Date.parse("2026-02-01"));
});
test("queue age survives newer updates and clears only when the current revision is delivered", async () => {
  await insertGuest();
  await pg.exec("UPDATE cio_projection_queue SET pending_since='2026-01-01T00:00:00Z'");
  await mark();
  assert.equal(new Date((await queue()).pending_since).getTime(),Date.parse("2026-01-01"));
  await runCioProjectionBatch({db:adapter(),fetchImpl:withProfileLookup(async()=>new Response("",{status:200}))});
  assert.equal((await queue()).pending_since,null);
  await mark(); assert.ok(new Date((await queue()).pending_since).getTime()>Date.parse("2026-01-01"));
});
test("unchanged completeness refreshes do not requeue an entire event", async () => {
  await insertGuest();
  await pg.exec("INSERT INTO luma_event_sync_state(event_id,last_guest_sync_at,last_status,updated_at) VALUES('evt-1',now(),'success',now())");
  const revision=(await queue()).revision;
  await pg.exec("UPDATE luma_event_sync_state SET last_guest_sync_at=now(),last_event_sync_at=now(),updated_at=now()");
  assert.equal((await queue()).revision,revision);
  await pg.exec("UPDATE luma_event_sync_state SET truncated=true");
  assert.ok((await queue()).revision>revision);
});
test("live updates jump ahead of history while every fifth claim allows old work through", async () => {
  process.env.CIO_SYNC_FULL_ROLLOUT="true";
  await pg.exec(`INSERT INTO luma_people(person_id,name,email_lower) VALUES('history','History','history@example.com');
    INSERT INTO luma_event_guests(event_id,person_id,email_lower,luma_approval_status) VALUES('evt-1','history','history@example.com','approved');
    UPDATE cio_projection_queue SET priority=0,next_attempt_at='2026-01-01' WHERE email='history@example.com';`);
  for(let i=0;i<5;i++) {
    await pg.query("INSERT INTO luma_people(person_id,name,email_lower) VALUES($1,'Live',$2)",[`live-${i}`,`live-${i}@example.com`]);
    await pg.query("INSERT INTO luma_event_guests(event_id,person_id,email_lower,luma_approval_status) VALUES('evt-1',$1,$2,'approved')",[`live-${i}`,`live-${i}@example.com`]);
    await pg.query("SELECT cio_mark_email($1,true)::text",[`live-${i}@example.com`]);
  }
  const sent:string[]=[];
  await runCioProjectionBatch({db:adapter(),maxItems:5,fetchImpl:withProfileLookup(async(url)=>{sent.push(Buffer.from(String(url).split("cio_").at(-1)!,"hex").toString());return new Response("",{status:200})})});
  assert.equal(sent.length,5); assert.ok(sent[0].startsWith("live-")); assert.equal(sent[4],"history@example.com");
});

// Fake App API lookups are separate from the Track callback so queue tests
// count actual projection writes and inject failures at the intended boundary.
function withProfileLookup(track: typeof fetch): typeof fetch {
  return async (url, options) => {
    if (options?.method === "GET") {
      const address = new URL(String(url)).searchParams.get("email")!;
      return Response.json({results:[{email:address,cio_id:Buffer.from(address).toString("hex"),id:null}]});
    }
    return track(url,options);
  };
}

test("new profiles remain durable and resume automatically after creation review", async () => {
  await insertGuest();let writes=0;
  const mock:typeof fetch=async(_url,opts)=>opts?.method==="GET" ? Response.json({results:[]})
    : (writes++,new Response("",{status:200}));
  const db=adapter();const held=await runCioProjectionBatch({db,fetchImpl:mock});
  assert.ok("held" in held);assert.equal(held.held,1);assert.equal(writes,0);assert.equal((await queue()).attempts,0);
  assert.equal(String((await queue()).sent_revision),"0");assert.equal((await queue()).payload_hash,null);
  assert.equal((await queue()).last_error,"cio_profile_creation_disabled");
  process.env.CIO_SYNC_PROFILE_MODE="create_reviewed";
  await pg.exec("UPDATE cio_projection_queue SET next_attempt_at=now()");
  await runCioProjectionBatch({db,fetchImpl:mock});
  assert.equal(writes,1);assert.equal((await queue()).sent_revision,(await queue()).revision);
});

test("ambiguous identity is quarantined without acknowledging or writing a profile", async () => {
  await insertGuest();let writes=0;
  await runCioProjectionBatch({db:adapter(),fetchImpl:async(_url,opts)=>{
    if(opts?.method!=="GET")writes++;
    return Response.json({results:[{email,cio_id:"a1"},{email,cio_id:"a2"}]});
  }});
  const row=await queue();assert.equal(writes,0);assert.equal(row.attempts,10);
  assert.equal(String(row.sent_revision),"0");assert.equal(row.last_error,"cio_identity_ambiguous");
});
