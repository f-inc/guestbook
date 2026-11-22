import assert from "node:assert/strict";
import test from "node:test";
import { eventAnalytics } from "./analytics/events/handler";

const token=`gb_live_${"a".repeat(64)}`;
const request=(query="from=2026-01-01&to=2026-02-01",authorization=`Bearer ${token}`)=>new Request(`https://events.example.test/api/v1/analytics/events?${query}`,{headers:{authorization}});
function fixture() {
  let scopes=["events:read","guests:read"], revokedAt:Date|null=null;
  const captured:{where?:any;sql?:any;reads:number}={reads:0};
  const event=(eventId:string,complete=true)=>({eventId,title:"Workshop",startsAt:new Date("2026-01-02T20:00:00Z"),endsAt:new Date("2026-01-02T21:00:00Z"),location:"Hall",category:"Community",capacity:30,catalogActive:true,syncState:{lastGuestSyncAt:complete?new Date("2026-01-03T00:00:00Z"):null,lastStatus:complete?"success":"running",truncated:false}});
  let rows=[event("allowed-one"),event("allowed-incomplete",false),event("allowed-empty")];
  const tx={lumaEvent:{findMany:async(args:any)=>{captured.where=args.where;return rows;}},$queryRaw:async(sql:any)=>{captured.sql=sql;return [{eventId:"allowed-one",registrations:20,accepted:15,checkedIn:10}];}};
  const db={integrationApiKey:{findUnique:async()=>({id:"key",scopes,eventIds:["allowed-one","allowed-incomplete","allowed-empty"],revokedAt,expiresAt:null})},$transaction:async(callback:any,options:any)=>{assert.equal(options.isolationLevel,"RepeatableRead");captured.reads++;return callback(tx);}};
  return {db:db as any,captured,setScopes:(value:string[])=>{scopes=value;},revoke:()=>{revokedAt=new Date();},setRows:(value:any[])=>{rows=value;},event};
}

test("scoped indexed summaries omit identities and distinguish incomplete guest indexes from empty events",async()=>{
  const f=fixture();const response=await eventAnalytics(request(),f.db);
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");
  const body:any=await response.json();
  assert.equal(body.complete,true);assert.equal(body.source,"guestbook-index");
  assert.equal(body.data[0].attendance.checkedIn,10);
  assert.equal(body.data[1].attendance,null);
  assert.equal(body.data[2].attendance.registrations,0);
  assert.deepEqual(f.captured.where.eventId.in,["allowed-one","allowed-incomplete","allowed-empty"]);
  assert(f.captured.sql.values.includes("allowed-one"));
  assert(!f.captured.sql.values.includes("allowed-incomplete"));
  assert(!JSON.stringify(body).includes("email"));assert(!JSON.stringify(body).includes("syncState"));
});
test("missing scopes, revoked keys and malformed ranges cannot read metrics",async()=>{
  const f=fixture();assert.equal((await eventAnalytics(request(undefined,""),f.db)).status,401);
  f.setScopes(["events:read"]);assert.equal((await eventAnalytics(request(),f.db)).status,403);
  f.setScopes(["events:read","guests:read"]);
  for(const query of ["from=2026-02-30&to=2026-03-01","from=2026-01-01&to=2028-01-01","from=2026-01-01&to=2026-01-01","from=2026-01-01&from=2026-01-02&to=2026-02-01","from=2026-01-01&to=2026-02-01&limit=1"]){
    // Each request independently validates before any data read.
    assert.equal((await eventAnalytics(request(query),f.db)).status,400);
  }
  assert.equal(f.captured.reads,0);
  f.revoke();assert.equal((await eventAnalytics(request(),f.db)).status,401);
});
test("size limits and Pacific boundaries do not silently truncate event coverage",async()=>{
  const f=fixture();f.setRows(Array.from({length:501},(_,i)=>f.event(`event-${i}`)));
  assert.equal((await eventAnalytics(request(),f.db)).status,503);
  const previous=f.event("previous"),last=f.event("last");
  previous.startsAt=new Date("2026-01-01T07:59:00Z");last.startsAt=new Date("2026-02-01T07:59:00Z");
  f.setRows([previous,last]);const body:any=await (await eventAnalytics(request(),f.db)).json();
  assert.deepEqual(body.data.map((event:any)=>event.id),["last"]);
});
