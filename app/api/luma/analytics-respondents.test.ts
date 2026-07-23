import assert from "node:assert/strict";
import test from "node:test";
import { ANALYTICS_RESPONDENT_PAGE_SIZE, parseAnalyticsRespondentQuery } from "./analytics-respondents";

test("parses a bounded analytics respondent page", () => {
  const params = new URLSearchParams();
  params.append("event_id", " evt-1 ");
  params.append("event_id", "evt-2");
  params.append("event_id", "evt-1");
  params.set("question", "  Where are you at?  ");
  params.set("answer", "  Shipped Prototype  ");
  params.set("respondent_cursor", "20");

  assert.deepEqual(parseAnalyticsRespondentQuery(params), {
    eventIds: ["evt-1", "evt-2"],
    question: "Where are you at?",
    answer: "Shipped Prototype",
    cursor: 20,
    pageSize: ANALYTICS_RESPONDENT_PAGE_SIZE,
  });
});

test("rejects invalid event ids and clamps respondent cursors", () => {
  const params = new URLSearchParams({
    event_id: "bad event",
    question: "Question",
    respondent_cursor: "9999999",
  });

  const query = parseAnalyticsRespondentQuery(params);
  assert.deepEqual(query.eventIds, []);
  assert.equal(query.cursor, 1_000_000);
  assert.equal(query.pageSize, 10);
});
