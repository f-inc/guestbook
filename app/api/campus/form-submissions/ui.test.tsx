import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerValue, submissionQuery } from "../../../requests/answers";

test("submission filters are encoded and page offsets are explicit", () => {
  const query = new URLSearchParams(submissionQuery(" guest+one@example.com ", 50));
  assert.equal(query.get("formKey"), "event-request");
  assert.equal(query.get("q"), "guest+one@example.com");
  assert.equal(query.get("offset"), "50");
  assert.equal(query.get("limit"), "25");
  assert.equal(new URLSearchParams(submissionQuery("", 0)).has("q"), false);
});

test("all Campus answer values survive nested rendering and HTML is escaped", () => {
  const html = renderToStaticMarkup(createElement(AnswerValue, { value: { userId: "test-user", photoUrl: "https://example.test/photo", formAnswers: { bio: "<script>alert(1)</script>", founderCount: 0, hardware: false, labAccess: null, funFact: "", custom: ["first", { nestedField: "second" }] } } }));
  for (const text of ["test-user", "https://example.test/photo", "form Answers", "founder Count", ">0<", "No (false)", "Not provided (null)", "Empty response", "first", "nested Field", "second", "&lt;script&gt;"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<script>"));
  assert.ok(renderToStaticMarkup(createElement(AnswerValue, { value: {} })).includes("No answers"));
  assert.ok(renderToStaticMarkup(createElement(AnswerValue, { value: [] })).includes("Empty list"));
});

test("event review preserves local event times, unknown answers, and safe links", async () => {
  const { eventDate, EventRequestDetail } = await import("../../../requests/event-request-ui");
  assert.equal(eventDate("2026-10-15T17:00:00"), "Oct 15, 2026, 5:00 PM");
  const html = renderToStaticMarkup(createElement(EventRequestDetail, { request: { id: "mock-request", form_key: "event-request", form_version: 3, created_at: "2026-10-13T10:00:00Z", name: "Test organizer", email: "test@example.test", answers: { companyName: "Example company", startAt: "2026-10-15T17:00:00", participantCount: 0, budget: "$500", timeZone: "America/Los_Angeles", specialRequests: "Projector please", eventLink: "javascript:alert(1)", companyUrl: "https://example.test", extraField: "Keep this answer" } } }));
  for (const value of ["Example company", "5:00 PM", "$500", "Projector please", "America/Los_Angeles", "Keep this answer", "test@example.test", 'href="https://example.test/"']) assert.ok(html.includes(value), value);
  assert.ok(!html.includes('href="javascript:'));
});

test("request titles combine company and event names with a legacy fallback", async () => {
  const { requestTitle } = await import("../../../requests/event-request-ui");
  assert.equal(requestTitle({ companyName: "Vercel", eventName: "AI Workshop" }), "Vercel - AI Workshop");
  assert.equal(requestTitle({ companyName: "Vercel" }), "Vercel");
});
