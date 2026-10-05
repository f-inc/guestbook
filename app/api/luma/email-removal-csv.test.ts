import test from "node:test";
import assert from "node:assert/strict";
import { removalCsv } from "./email-removal-csv";

test("exports the whole job, including failures, with CSV escaping and safe spreadsheet text", async () => {
  let calls = 0;
  const job = {id:"job-test", calendars:[{id:"cal-test",name:'Community, "West"'}], createdAt:new Date("2026-10-05T09:00:00Z"), confirmedAt:null};
  const rows = Array.from({length: 75}, (_, i) => ({name:i===0?'=HYPERLINK("https://example.com")':"Person", emailLower:`person${i}@example.com`,calendarId:"cal-test",reason:"blocked",status:i===74?"failed":"succeeded",error:i===74?'Rejected, "invalid"\nReview':null,startedAt:job.createdAt,completedAt:null}));
  const db = {$queryRaw:async query => {
    assert.match(query.sql, /^SELECT /);
    assert.ok(query.values.includes("job-test"));
    return calls++ === 0 ? [job] : rows;
  }};
  const csv = await removalCsv("job-test", db);
  assert.equal(calls, 2);
  assert.ok(csv.startsWith('\uFEFF"Name","Email"'));
  assert.equal((csv.match(/@example\.com/g)||[]).length,75);
  assert.ok(csv.includes('"Community, ""West"""'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.ok(csv.includes('"failed","Rejected, ""invalid""\nReview"'));
  assert.ok(csv.includes('"2026-10-05T09:00:00.000Z"'));
});

test("missing or unknown jobs cannot export data", async () => {
  await assert.rejects(removalCsv("", {$queryRaw:()=>assert.fail("must not query")}), {status:400});
  await assert.rejects(removalCsv("missing", {$queryRaw:async()=>[]}), {status:404});
});

test("oversized jobs fail explicitly instead of silently truncating", async () => {
  let calls=0;
  await assert.rejects(removalCsv("large", {$queryRaw:async()=>calls++===0?[{calendars:[]}]:Array(50001).fill({})}), {status:413});
});
