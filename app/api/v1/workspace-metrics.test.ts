import assert from "node:assert/strict";
import test from "node:test";
import { metricPeople } from "../metrics/handler";

test("workspace metrics authorizes before reading, validates scope and preserves pagination", async (t) => {
  const prior = process.env.GUESTBOOK_KEY;
  process.env.GUESTBOOK_KEY = "synthetic-workspace-key";
  t.after(() => {
    if (prior === undefined) delete process.env.GUESTBOOK_KEY;
    else process.env.GUESTBOOK_KEY = prior;
  });
  let calls = 0;
  const read = async (input: any) => {
    calls++;
    assert.deepEqual(input.eventIds, ["event-example"]);
    assert.deepEqual(input.historyScope, ["history-example"]);
    assert.equal(input.page, 2);
    return {
      total: 51,
      rows: [
        {
          personId: "person-example",
          eventId: "event-example",
          name: "Example Person",
          eventTitle: "Example Event",
        },
      ],
    };
  };
  const request = (query: string, key?: string) =>
    new Request(`https://guestbook.example.test/api/metrics?${query}`, {
      headers: key ? { "x-guestbook-key": key } : {},
    });
  const query =
    "stage=registrations&from=2026-10-01&to=2026-11-01&event=event-example&history=history-example&page=2&expected=51";
  assert.equal((await metricPeople(request(query), read)).status, 401);
  for (const invalid of [
    query + "&page=1",
    query.replace("registrations", "constructor"),
    query.replace("2026-10-01", "2026-02-30"),
  ])
    assert.equal(
      (await metricPeople(request(invalid, "synthetic-workspace-key"), read)).status,
      400,
    );
  assert.equal(calls, 0);
  const response = await metricPeople(request(query, "synthetic-workspace-key"), read);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as {
    stageLabel: string;
    page: number;
    expected: number;
    data: { total: number };
  };
  assert.equal(body.stageLabel, "Event registrations");
  assert.equal(body.page, 2);
  assert.equal(body.expected, 51);
  assert.equal(body.data.total, 51);
  assert.equal(calls, 1);
  const failed = await metricPeople(request(query, "synthetic-workspace-key"), async () => {
    throw Error("private database details");
  });
  assert.equal(failed.status, 503);
  assert(!(await failed.text()).includes("private database details"));
});
