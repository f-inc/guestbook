import test, {beforeEach, afterEach} from "node:test";
import { removalCanConfirm, removalCanPreview } from "./email-removal-policy";
import assert from "node:assert/strict";
import { calendarIdentity, confirmRemoval, previewRemoval, removalStatus, removeCalendarEmail, retryFailedRemoval, runRemovalTick } from "./email-removal";
import { activePersonSql, removedEmails } from "./email-inactivity";
import { Prisma, PrismaClient } from "@prisma/client";
import { verificationOverview } from "./email-verification";
import { eligibleInvitationRecipients } from "./invite-tracking-store";

const policyKeys = ["NODE_ENV", "RAILWAY_ENVIRONMENT_NAME", "GUESTBOOK_ENVIRONMENT", "EMAIL_REMOVAL_ENABLED"];
let savedPolicy: Record<string,string|undefined>;
beforeEach(() => {
  savedPolicy = Object.fromEntries(policyKeys.map(k=>[k,process.env[k]]));
  Object.assign(process.env, {NODE_ENV:"production", RAILWAY_ENVIRONMENT_NAME:"production", EMAIL_REMOVAL_ENABLED:"true"});
});
afterEach(() => { for(const k of policyKeys) { if(savedPolicy[k]===undefined)delete process.env[k];else process.env[k]=savedPolicy[k]; } });

test("removal verifies calendar identity before any destructive call", async () => {
  process.env.LUMA_API_KEY_987 = "test-only-key";
  try {
    let calls=0;
    const fetcher:any=async()=>{calls++;return Response.json({calendar:{api_id:"cal-other",name:"Other"}});};
    const result=await removeCalendarEmail({id:"cal-selected",envName:"LUMA_API_KEY_987"},"test@example.com",fetcher);
    assert.equal(result.status,"failed"); assert.equal(calls,1);
    assert.throws(()=>calendarIdentity({ok:true}));
  } finally {delete process.env.LUMA_API_KEY_987;}
});
test("timeouts and server errors are uncertain, client rejection is retryable, success is confirmed", async () => {
  process.env.LUMA_API_KEY_987="test-only-key";
  try {
    for(const outcome of [204,400,429,500,"timeout"]) {
      let posts=0;
      const fetcher:any=async(url,init)=>{
        if(url.endsWith("/get"))return Response.json({calendar:{api_id:"cal-test"}});
        posts++;assert.equal(init.method,"POST");assert.deepEqual(JSON.parse(init.body),{email:"bad@example.com"});
        if(outcome==="timeout")throw new Error("network error");
        return new Response(null,{status:Number(outcome)});
      };
      const result=await removeCalendarEmail({id:"cal-test",envName:"LUMA_API_KEY_987"},"bad@example.com",fetcher);
      assert.equal(result.status,outcome===204?"succeeded":outcome===400||outcome===429?"failed":"unknown");
      assert.equal(posts,1,"must never automatically retry a removal POST");
    }
  } finally {delete process.env.LUMA_API_KEY_987;}
});

// Integration tests require a separately provisioned temporary DB. Never fall
// back to DB_URL or the application's configured (potentially production) DB.
const url=process.env.EMAIL_REMOVAL_TEST_DATABASE_URL;
test("isolated database: preview, confirmation, partial failure, recovery and visibility", {skip:!url}, async()=>{
  const parsed=new URL(url!);
  assert.match(parsed.searchParams.get("host") || "",/^\/private\/tmp\/guestbook-removal-test-[A-Za-z0-9]+$/);
  const db=new PrismaClient({datasources:{db:{url}}});
  const originalFetch=globalThis.fetch, originalEnabled=process.env.EMAIL_REMOVAL_ENABLED;
  const savedKeys=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^LUMA_API_KEY(?:_\d+)?$/.test(k)));
  Object.keys(savedKeys).forEach(k=>delete process.env[k]);
  process.env.LUMA_API_KEY="fake";process.env.LUMA_API_KEY_1="fake-second";process.env.EMAIL_REMOVAL_ENABLED="true";
  globalThis.fetch=async(_url,init)=>Response.json({calendar:{api_id:(init?.headers as any)["x-luma-api-key"]==="fake"?"cal-one":"cal-two",name:"Test calendar"}});
  try {
    const location:any[]=await db.$queryRaw`SHOW data_directory`;
    assert.ok(location[0].data_directory.startsWith(parsed.searchParams.get("host")+"/"));
    await db.$executeRaw`TRUNCATE email_inactive, email_removal_items, email_removal_jobs, email_addresses, luma_people CASCADE`;
    await db.lumaPerson.createMany({data:[{personId:"single",name:"Single",email:"bad@example.com"},{personId:"multi",name:"Multi",email:"old@example.com"}]});
    await db.emailAddress.createMany({data:[
      {emailLower:"bad@example.com",name:"Single",personId:"single",lumaBlockedReason:"bounced"},
      {emailLower:"old@example.com",name:"Multi",personId:"multi",state:"undeliverable",checkedAt:new Date()},
      {emailLower:"good@example.com",personId:"multi",state:"deliverable",checkedAt:new Date()},
      {emailLower:"maybe@example.com",state:"risky",checkedAt:new Date()},
    ]});
    const preview:any=await previewRemoval({scope:"all",calendarIds:["cal-one","cal-two"]},db);
    assert.equal(preview.job.emails,2);assert.equal(preview.job.total,4);assert.equal(preview.job.affectedPeople,1);
    assert.equal(preview.job.calendars[0].envName,undefined,"do not expose key identifiers to clients");
    await assert.rejects(confirmRemoval(preview.job.id,"wrong",db));
    assert.equal(await runRemovalTick(db,async()=>{throw Error("draft must not execute");}),false);
    await confirmRemoval(preview.job.id,"REMOVE_BLOCKED_EMAILS",db);
    await assert.rejects(confirmRemoval(preview.job.id,"REMOVE_BLOCKED_EMAILS",db));
    let requests=0;
    const remove=async(scope,email)=>{requests++;return scope.id==="cal-two"&&email==="bad@example.com"?{status:"failed",error:"Test rejection"}:{status:"succeeded"};};
    await runRemovalTick(db,remove);
    assert.equal((await db.$queryRaw<any[]>`SELECT * FROM email_inactive`).length,0,"one calendar success must not deactivate email");
    assert.ok((await removedEmails(["bad@example.com"],db)).has("bad@example.com"),"partial removal must stay excluded from invitations");
    await Promise.all([runRemovalTick(db,remove),runRemovalTick(db,remove)]);
    await runRemovalTick(db,remove);
    const status:any=await removalStatus(preview.job.id,0,db);
    assert.equal(status.job.status,"needs_attention");assert.equal(status.job.succeeded,3);assert.equal(requests,4);
    assert.deepEqual((await db.$queryRaw<any[]>`SELECT "emailLower" FROM email_inactive`).map(r=>r.emailLower),["old@example.com"]);
    assert.equal((await db.$queryRaw<any[]>`SELECT * FROM guestbook_inactive_people`).length,0,"alternate active email keeps person visible");
    await retryFailedRemoval(preview.job.id,db);
    await runRemovalTick(db,async()=>{requests++;return {status:"succeeded"};});
    assert.equal(requests,5,"retry only failed items");
    assert.deepEqual((await db.$queryRaw<any[]>`SELECT * FROM guestbook_inactive_people`).map(r=>r.person_id),["single"]);
    await db.emailAddress.update({where:{emailLower:"bad@example.com"},data:{lumaBlockedReason:null,state:"deliverable",checkedAt:new Date()}});
    const recipients=await eligibleInvitationRecipients([{email:"BAD@example.com"},{email:"good@example.com"}],db);
    assert.deepEqual(recipients.eligible.map(r=>r.email),["good@example.com"],"verification refresh must not reactivate removed email");
    await db.lumaPerson.update({where:{personId:"single"},data:{email:"bad@example.com",name:"Synced again"}});
    assert.equal((await db.$queryRaw<any[]>`SELECT * FROM guestbook_inactive_people`).length,1,"sync must not resurrect removed address");
    const inactivePage = await verificationOverview("", "inactive", 0, db);
    assert.equal(inactivePage.rows.length, 2);
    assert.ok(inactivePage.rows.every(r => r.decision.status === "inactive"));
    const activePage = await verificationOverview("", "all", 0, db);
    assert.equal(activePage.rows.length, 2);
    assert.equal(activePage.summary.inactive, 2);
    assert.equal(activePage.summary.total, 2);
    await db.emailAddress.create({data:{emailLower:"new@example.com",personId:"single"}});
    assert.equal((await db.$queryRaw<any[]>`SELECT * FROM guestbook_inactive_people`).length,0,"new active email makes person visible");
    assert.equal((await db.$queryRaw(Prisma.sql`SELECT person_id FROM luma_people p WHERE ${activePersonSql(Prisma.sql`p.person_id`)}`) as any[]).length,2);

    await db.emailAddress.create({data:{emailLower:"interrupted@example.com",lumaBlockedReason:"bounced"}});
    const pending:any=await previewRemoval({emails:["interrupted@example.com"],calendarIds:["cal-one"]},db);
    await confirmRemoval(pending.job.id,"REMOVE_BLOCKED_EMAILS",db);
    await db.$executeRaw(Prisma.sql`UPDATE email_removal_items SET status='processing', "startedAt"=now()-interval '3 minutes' WHERE "jobId"=${pending.job.id}`);
    await runRemovalTick(db,async()=>{throw Error("expired claim must not retry POST");});
    const unknown:any=await removalStatus(pending.job.id,0,db);
    assert.equal(unknown.job.unknown,1);assert.equal(unknown.job.status,"needs_attention");
    await retryFailedRemoval(pending.job.id,db);
    await runRemovalTick(db,async()=>{throw Error("unknown must not retry");});
    assert.equal((await removalStatus(pending.job.id,0,db) as any).job.unknown,1);

    const restored:any=await previewRemoval({emails:["interrupted@example.com"],calendarIds:["cal-one"]},db);
    await confirmRemoval(restored.job.id,"REMOVE_BLOCKED_EMAILS",db);
    await db.emailAddress.update({where:{emailLower:"interrupted@example.com"},data:{lumaBlockedReason:null}});
    await runRemovalTick(db,async()=>{throw Error("newly unblocked address must be skipped");});
    assert.equal((await removalStatus(restored.job.id,0,db) as any).job.skipped,1);
    const expired:any=await previewRemoval({emails:["maybe@example.com","good@example.com"],calendarIds:["cal-one"]},db).catch(e=>e);
    assert.match(expired.message,/No currently blocked/);
    await db.emailAddress.update({where:{emailLower:"interrupted@example.com"},data:{lumaBlockedReason:"bounced"}});
    const stale:any=await previewRemoval({emails:["interrupted@example.com"],calendarIds:["cal-one"]},db);
    await db.$executeRaw(Prisma.sql`UPDATE email_removal_jobs SET "expiresAt"=now()-interval '1 minute' WHERE id=${stale.job.id}`);
    await assert.rejects(confirmRemoval(stale.job.id,"REMOVE_BLOCKED_EMAILS",db),/expired/);
  } finally {
    globalThis.fetch=originalFetch;
    delete process.env.LUMA_API_KEY;delete process.env.LUMA_API_KEY_1;
    Object.assign(process.env,savedKeys);
    if(originalEnabled===undefined)delete process.env.EMAIL_REMOVAL_ENABLED;else process.env.EMAIL_REMOVAL_ENABLED=originalEnabled;
    await db.$disconnect();
  }
});

test("only an enabled production deployment can execute removals", () => {
  for (const env of [
    {NODE_ENV:"development", EMAIL_REMOVAL_ENABLED:"true", RAILWAY_ENVIRONMENT_NAME:"production"},
    {NODE_ENV:"production", EMAIL_REMOVAL_ENABLED:"true", RAILWAY_ENVIRONMENT_NAME:"staging"},
    {NODE_ENV:"production", EMAIL_REMOVAL_ENABLED:"true"},
    {NODE_ENV:"production", EMAIL_REMOVAL_ENABLED:"false", RAILWAY_ENVIRONMENT_NAME:"production"},
  ]) assert.equal(removalCanConfirm(env),false);
  assert.equal(removalCanConfirm({NODE_ENV:"production",EMAIL_REMOVAL_ENABLED:"true",RAILWAY_ENVIRONMENT_NAME:"production"}),true);
  assert.equal(removalCanPreview({NODE_ENV:"development"}),true);
});
test("development cannot confirm, retry, dispatch or claim production jobs", async () => {
  Object.assign(process.env,{NODE_ENV:"development"});
  const db:any=new Proxy({}, {get(){throw Error("Must not access database for removal execution");}});
  await assert.rejects(confirmRemoval("any","REMOVE_BLOCKED_EMAILS",db),/only in production/);
  await assert.rejects(retryFailedRemoval("any",db),/only in production/);
  await assert.rejects(removeCalendarEmail({id:"cal-test",envName:"LUMA_API_KEY"},"fake@example.com",async()=>{throw Error("Must not call Luma");}),/only in production/);
  assert.equal(await runRemovalTick(db),undefined);
});
test("development preview and pagination never persist a job", async () => {
  Object.assign(process.env,{NODE_ENV:"development",EMAIL_REMOVAL_ENABLED:"false"});
  const keys=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^LUMA_API_KEY(?:_\d+)?$/.test(k)));
  Object.keys(keys).forEach(k=>delete process.env[k]);process.env.LUMA_API_KEY="mock-key";
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({calendar:{id:"cal-test",name:"Test"}});
  let reads=0;
  const db:any={
    $queryRaw:async()=> ++reads%2===1 ? Array.from({length:55},(_,i)=>({emailLower:`test${i}@example.com`,lumaBlockedReason:"bounced"})) : [{total:55}],
    $transaction:async()=>{throw Error("Preview must not write to the shared database");},
  };
  try {
    const first:any=await previewRemoval({scope:"all",calendarIds:["cal-test"]},db);
    assert.equal(first.previewOnly,true);assert.equal(first.job.id,undefined);assert.equal(first.rows.length,50);assert.equal(first.hasMore,true);
    const last:any=await previewRemoval({scope:"all",calendarIds:["cal-test"],offset:50},db);
    assert.equal(last.rows.length,5);assert.equal(last.hasMore,false);assert.equal(last.job.affectedPeople,55);
  }finally{globalThis.fetch=originalFetch;delete process.env.LUMA_API_KEY;Object.assign(process.env,keys);}
});
