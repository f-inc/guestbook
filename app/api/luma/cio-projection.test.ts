import assert from "node:assert/strict";
import test from "node:test";
import { buildCioProjection, cioRuntimeMode, cioRetryDelay } from "./cio-projection";
import { sendCioProjection, runCioProjectionBatch } from "./cio-sync";
import { advanceLumaSource, validatedLumaPage, reconcileLumaSources } from "./cio-source";
import { runCioScheduledSync } from "./cio-scheduler";
import { mergeLumaEventWebhook, parseLumaEventWebhook } from "./webhooks/event-webhook";
import { requireCioWorker } from "../cio/auth";

const email = "builder@example.com";
const guest = (changes = {}): any => ({ eventId: "evt-1", personId: "usr-1", emailLower: email,
  lumaApprovalStatus: "approved", registeredAt: "2026-10-01T00:00:00Z", checkedInAt: null,
  syncedAt: "2026-10-02T00:00:00Z", person: { emailLower: email },
  event: { title: "Night Hack", category: "hackathon", startsAt: "2026-10-30T00:00:00Z", raw: {},
    syncState: { lastGuestSyncAt: new Date(), lastStatus: "success", truncated: false } }, ...changes });
const project = (guests, rest = {}) => buildCioProjection({ email, guests, ...rest });
const sendEnv = { NODE_ENV: "production", GUESTBOOK_ENVIRONMENT: "production", CIO_SYNC_ENABLED: "true",
  CIO_SYNC_SEND_ENABLED: "true", CUSTOMERIO_SITE_ID: "test", CUSTOMERIO_TRACK_API_KEY: "test",
  CUSTOMERIO_APP_API_KEY: "app-test", CIO_SYNC_IDENTITY_CONFIRMED: "email_lookup",
  CIO_SYNC_AUTOMATIONS_REVIEWED: "true", CIO_SYNC_ALLOWED_EMAILS: email };

test("invitation with a joined date is never a registration or attendance", () => {
  const p = project([guest({ lumaApprovalStatus: "invited" })]);
  assert.equal(p.hasRegistrations, false); assert.equal(p.attrs.finc_luma_checkin_count, 0);
});
test("declining an invitation with only a created-at fallback does not invent a registration",()=>{
  assert.equal(project([guest({lumaApprovalStatus:"declined",raw:{created_at:"2026-10-01"}})]).hasRegistrations,false);
  assert.equal(project([guest({lumaApprovalStatus:"declined",raw:{registered_at:"2026-10-01"}})]).hasRegistrations,true);
});
test("approval, attendance and active registration stay distinct; cancellation removes approval", () => {
  const approved = project([guest()]);
  assert.deepEqual(approved.attrs.finc_luma_approved_event_ids, ["evt-1"]);
  assert.deepEqual(approved.attrs.finc_luma_checked_in_event_ids, []);
  const cancelled = project([guest({ lumaApprovalStatus: "declined" })]);
  assert.deepEqual(cancelled.attrs.finc_luma_registered_event_ids, ["evt-1"]);
  assert.deepEqual(cancelled.attrs.finc_luma_approved_event_ids, []);
  assert.deepEqual(cancelled.attrs.finc_luma_active_event_ids, []);
});
test("check-in correction removes attendance and recomputes counts without increments", () => {
  const row = guest({ checkedInAt: "2026-10-30T01:00:00Z" });
  assert.equal(project([row,row]).attrs.finc_luma_checkin_count, 1);
  assert.deepEqual(project([row]).attrs, project([row]).attrs);
  assert.equal(project([{ ...row, checkedInAt: null }]).attrs.finc_luma_checkin_count, 0);
});
test("dates use Unix seconds so Customer.io recency segments can match", () => {
  const checkedInAt = "2026-10-30T01:00:00Z";
  const attrs = project([guest({ checkedInAt })]).attrs;
  assert.equal(attrs.finc_luma_last_checked_in_at, Date.parse(checkedInAt) / 1000);
  assert.equal(attrs.finc_luma_event_records[0].starts_at, Date.parse("2026-10-30T00:00:00Z") / 1000);
  assert.equal(attrs.finc_luma_event_records[0].registered_at, Date.parse("2026-10-01T00:00:00Z") / 1000);
});
test("canceled event removes active and approved eligibility but retains true attendance", () => {
  const row = guest({ checkedInAt: "2026-10-30T01:00:00Z" }); row.event.raw.status = "canceled";
  const p = project([row]);
  assert.deepEqual(p.attrs.finc_luma_active_event_ids, []);
  assert.deepEqual(p.attrs.finc_luma_approved_event_ids, []);
  assert.equal(p.attrs.finc_luma_checkin_count,1);
});
test("changed email and conflicting registrations are marked for review", () => {
  const p = project([guest({ person: { emailLower: "new@example.com" } })]);
  assert.equal(p.attrs.finc_luma_identity_review,true); assert.equal(p.attrs.finc_luma_marketing_blocked,true);
  assert.equal(project([guest(),guest({ personId:"usr-2",lumaApprovalStatus:"declined" })]).attrs.finc_luma_identity_review,true);
});
test("only mapped calendar opt-outs block newsletter targeting; no consent attribute is written", () => {
  const scoped = { optOuts:[{calendarId:"cal-partner"}] };
  assert.equal(project([guest()],scoped).attrs.finc_luma_marketing_blocked,false);
  const p = project([guest()],{...scoped,newsletterCalendarIds:["cal-partner"]});
  assert.equal(p.attrs.finc_luma_marketing_blocked,true);
  assert.ok(Object.keys(p.attrs).every(k=>k.startsWith("finc_luma_")));
  assert.ok(!("unsubscribed" in p.attrs));
});
test("stale verification cannot become a fresh block; actual restrictions and inactivity persist", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  assert.equal(project([guest()],{now,address:{state:"undeliverable",checkedAt:"2026-08-01"}}).attrs.finc_luma_marketing_blocked,false);
  assert.equal(project([guest()],{now,address:{state:"undeliverable",checkedAt:"2026-10-21"}}).attrs.finc_luma_marketing_blocked,true);
  assert.equal(project([guest()],{now,inactive:true}).attrs.finc_luma_marketing_blocked,true);
});
test("incomplete pages cannot claim complete indexed history",()=>{
  const row=guest(); row.event.syncState.truncated=true;
  assert.equal(project([row]).attrs.finc_luma_indexed_records_complete,false);
});
test("webhooks retain proven coverage but cannot turn failed or missing snapshots into complete history",()=>{
  const row=guest(); row.event.syncState.lastStatus="webhook";
  assert.equal(project([row]).attrs.finc_luma_indexed_records_complete,false);
  assert.equal(project([row],{coverage:{"evt-1":"2026-10-01"}}).attrs.finc_luma_indexed_records_complete,true);
  row.event.syncState.truncated=true;
  assert.equal(project([row],{coverage:{"evt-1":"2026-10-01"}}).attrs.finc_luma_indexed_records_complete,false);
});
test("stable hashes ignore input ordering and timestamp-only refreshes",()=>{
  const a=guest(), b=guest({eventId:"evt-2"});
  assert.equal(project([a,b]).hash,project([b,{...a,syncedAt:"2026-10-22"}]).hash);
});
test("oversized histories fail visibly rather than silently dropping events",()=>{
  assert.throws(()=>project(Array.from({length:1000},(_,i)=>guest({eventId:`evt-${i}`}))),/projection_too_large/);
});
test("production sending requires explicit identity, automation review and canary gates",()=>{
  assert.equal(cioRuntimeMode({}),"disabled");
  assert.equal(cioRuntimeMode({CIO_SYNC_ENABLED:"true"}),"preview");
  assert.throws(()=>cioRuntimeMode({...sendEnv,VERCEL_ENV:"preview"}),/production_identity/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CIO_SYNC_AUTOMATIONS_REVIEWED:"false"}),/automation_review/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CIO_SYNC_ALLOWED_EMAILS:""}),/canary/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CIO_SYNC_ALLOWED_EMAILS:" , invalid "}),/canary/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CUSTOMERIO_REGION:"typo"}),/region_invalid/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CUSTOMERIO_APP_API_KEY:""}),/credentials/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CIO_SYNC_PROFILE_MODE:"typo"}),/profile_mode/);
  assert.throws(()=>cioRuntimeMode({...sendEnv,CIO_SYNC_IDENTITY_CONFIRMED:"email_id"}),/identity_confirmation/);
});
test("sender resolves email-only profiles and updates cio_id without changing identifiers or consent",async()=>{
  const calls:any[]=[];
  const mock: typeof fetch=async(url,opts)=>{calls.push([url,opts]);return opts?.method==="GET"
    ? Response.json({results:[{email,id:null,cio_id:"abc123"}]}) : new Response("",{status:200});};
  await sendCioProjection(email,project([guest()]).attrs,mock,sendEnv);
  assert.equal(calls.length,2); assert.equal(calls[0][1].method,"GET"); assert.equal(calls[1][1].method,"PUT");
  assert.equal(new URL(calls[0][0]).searchParams.get("email"),email);
  assert.equal(calls[1][0],"https://track.customer.io/api/v1/customers/cio_abc123");
  const body=JSON.parse(calls[1][1].body); assert.equal(body._update,true);
  assert.equal(body.email,undefined); assert.equal(body.id,undefined);
  assert.equal(body.unsubscribed,undefined); assert.equal(body.double_optin,undefined);
  await assert.rejects(sendCioProjection(email,{unsubscribed:false},mock,sendEnv),/unowned/);
  await assert.rejects(sendCioProjection("other@example.com",{},mock,sendEnv),/canary/);
  assert.equal(calls.length,2);
});
test("missing profiles stay held by default; explicitly reviewed creation uses email and no external ID",async()=>{
  const writes:any[]=[];
  const mock:typeof fetch=async(url,opts)=>opts?.method==="GET" ? Response.json({results:[]})
    : (writes.push([url,JSON.parse(String(opts?.body))]),new Response("",{status:200}));
  await assert.rejects(sendCioProjection(email,{},mock,sendEnv),/profile_creation_disabled/);
  assert.equal(writes.length,0);
  await sendCioProjection(email,project([guest()]).attrs,mock,{...sendEnv,CIO_SYNC_PROFILE_MODE:"create_reviewed"});
  assert.equal(writes.length,1);assert.equal(writes[0][1].email,email);assert.equal(writes[0][1].id,undefined);
  assert.equal(writes[0][0],"https://track.customer.io/api/v1/customers/builder%40example.com");
  await assert.rejects(sendCioProjection(email,{finc_luma_identity_review:true},mock,{...sendEnv,CIO_SYNC_PROFILE_MODE:"create_reviewed"}),/identity_review_required/);
  assert.equal(writes.length,1);
});
test("ambiguous or malformed identity responses never produce a profile write",async()=>{
  for(const result of [{results:[{email,cio_id:"a1"},{email,cio_id:"a2"}]},
    {results:[{email:"other@example.com",cio_id:"a1"}]},{results:[{email,cio_id:null}]},{unexpected:[]}]) {
    let writes=0;
    await assert.rejects(sendCioProjection(email,{},async(_url,opts)=>{
      if(opts?.method!=="GET")writes++;return Response.json(result);
    },sendEnv),/cio_identity_/);
    assert.equal(writes,0);
  }
});
test("EU identity resolution encodes plus-addresses and preserves custom IDs",async()=>{
  const address="builder+test@example.com",calls:any[]=[];
  await sendCioProjection(address.toUpperCase(),{},async(url,opts)=>{
    calls.push([String(url),opts]);return opts?.method==="GET"
      ? Response.json({results:[{email:address,id:"custom-external-id",cio_id:"fed123"}]}) : new Response("",{status:200});
  },{...sendEnv,CUSTOMERIO_REGION:"eu",CIO_SYNC_ALLOWED_EMAILS:address});
  assert.ok(calls[0][0].startsWith("https://api-eu.customer.io/"));
  assert.ok(calls[0][0].includes("%2B"));assert.equal(new URL(calls[0][0]).searchParams.get("email"),address);
  assert.equal(calls[1][0],"https://track-eu.customer.io/api/v1/customers/cio_fed123");
  assert.equal(JSON.parse(calls[1][1].body).id,undefined);
});
test("provider errors expose status and retry-after without logging response content",async()=>{
  const mock:typeof fetch=async()=>new Response("sensitive provider body",{status:429,headers:{"retry-after":"120"}});
  await assert.rejects(sendCioProjection(email,{},mock,sendEnv),(e:any)=>e.message==="cio_http_429"&&e.retryAfter==="120");
  assert.equal(cioRetryDelay(0,"120"),120_000);
  assert.equal(cioRetryDelay(1,null),60_000);
});
test("worker authorization supports external scheduler and Vercel secret, rejecting missing auth",()=>{
  const old=process.env.CRON_SECRET; process.env.CRON_SECRET="test-".repeat(8);
  try { assert.doesNotThrow(()=>requireCioWorker(new Request("https://example.com",{headers:{authorization:`Bearer ${process.env.CRON_SECRET}`}})));
    assert.throws(()=>requireCioWorker(new Request("https://example.com")),/Unauthorized/);
  } finally { if(old===undefined) delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old; }
});
test("historical walk resumes guest pages and only reconciles absence after the last page",async()=>{
  const saved:any[]=[]; let n=0;
  const deps={request:async()=>++n===1?{entries:[{id:"gst-1",user_id:"usr-1"}],next_cursor:"next"}:{entries:[{id:"gst-2",user_id:"usr-2"}]},
    savePage:async(...args:any[])=>{saved.push(args);}};
  const s1=await advanceLumaSource({events:[{id:"evt-1"}],catalogDone:true},false,deps);
  assert.equal(s1.current?.cursor,"next"); assert.equal(saved[0][3],false);
  const s2=await advanceLumaSource(s1,false,deps);
  assert.equal(s2.current,null); assert.equal(saved[1][3],true); assert.equal(saved[1][2],saved[0][2]);
  const s3=await advanceLumaSource(s2,false,deps);
  assert.ok(s3.lastCycleAt); assert.equal(n,2);
});
test("failed page never advances cursor or deletes unobserved guests",async()=>{
  const state={current:{event:{id:"evt-1"},cursor:"resume",startedAt:"2026-10-01"}}; let saves=0;
  await assert.rejects(advanceLumaSource(state,false,{request:async()=>{throw new Error("outage")},savePage:async()=>{saves++;}}),/outage/);
  assert.equal(state.current.cursor,"resume"); assert.equal(saves,0);
  assert.throws(()=>validatedLumaPage({entries:[],has_more:true}),/missing_luma_cursor/);
  assert.throws(()=>validatedLumaPage({entries:[],next_cursor:"same"},"same"),/repeated_luma_cursor/);
});
test("new managed events are discovered without event-specific configuration",async()=>{
  const calls:any[]=[];
  const deps={request:async(path,params)=>{calls.push([path,params]);return {entries:[{event:{id:"evt-new"}},{event:{id:"external",platform:"external"}}],next_cursor:"catalog-2"}},savePage:async()=>{}};
  const state=await advanceLumaSource({},true,deps,new Date("2026-10-22"));
  assert.deepEqual(state.events,[{id:"evt-new"}]); assert.equal(state.catalogCursor,"catalog-2");
  assert.equal(calls[0][1].access,"manage"); assert.ok(state.after);
});

test("scheduler delivers first and isolates failures without leaking their contents",async()=>{
  const order:string[]=[];
  const result=await runCioScheduledSync({...sendEnv,CIO_SYNC_SOURCE_ENABLED:"true",CIO_SYNC_BACKFILL_ENABLED:"true"},{
    delivery:async()=>{order.push("delivery");return {sent:1}},
    backfill:async()=>{order.push("backfill");throw new Error("private provider details")},
    source:async()=>{order.push("source");return {pages:1}},
  });
  assert.deepEqual(order,["delivery","backfill","source"]);
  assert.equal(result.ok,false); assert.equal(result.delivery?.sent,1); assert.equal(result.source?.pages,1);
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("disabled sync never initializes a database or runs jobs",async()=>{
  const saved={...process.env};
  try {
    delete process.env.CIO_SYNC_ENABLED; delete process.env.CIO_SYNC_SOURCE_ENABLED;
    delete process.env.DB_URL; delete process.env.DB_RUNTIME_URL;
    assert.equal((await runCioProjectionBatch()).processed,0);
    assert.equal((await reconcileLumaSources()).pages,0);
    const bad=async()=>{throw new Error("must not run")};
    assert.deepEqual(await runCioScheduledSync({}, {delivery:bad,source:bad,backfill:bad}),{ok:true,mode:"disabled"});
  } finally {
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
    Object.assign(process.env,saved);
  }
});
test("partial event cancellation preserves the stored event and does not mutate the webhook",()=>{
  const payload={type:"event.canceled",data:{id:"evt-1"}};
  const result=mergeLumaEventWebhook(parseLumaEventWebhook(payload)!,{id:"evt-1",name:"Night Hack",start_at:"2026-10-30"});
  assert.equal(result.status,"canceled");assert.equal(result.name,"Night Hack");assert.equal(result.start_at,"2026-10-30");
  assert.deepEqual(payload.data,{id:"evt-1"});
  assert.throws(()=>parseLumaEventWebhook({type:"event.updated",data:{id:" "}}),/Event ID/);
  assert.equal(parseLumaEventWebhook({type:"guest.updated"}),null);
});
