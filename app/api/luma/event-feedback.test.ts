import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateEventFeedback,
  normalizeEventFeedback,
  normalizeEventFeedbackIds,
} from "./event-feedback";

test("normalizes, sorts, and summarizes Luma survey responses", () => {
  const feedback = normalizeEventFeedback({
    num_responses: 3,
    survey_responses: [
      {
        guest_id: "gst-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        rating: 4,
        feedback: "Useful conversations.",
        created_at: "2026-07-20T12:00:00.000Z",
      },
      {
        guest_id: "gst-2",
        name: "Grace Hopper",
        email: "grace@example.com",
        rating: 5,
        feedback: "",
        created_at: "2026-07-21T12:00:00.000Z",
      },
      {
        guest_id: "gst-3",
        name: "Alan Turing",
        email: "alan@example.com",
        rating: 5,
        feedback: "Great event.",
        created_at: "2026-07-19T12:00:00.000Z",
      },
    ],
  });

  assert.equal(feedback.totalResponses, 3);
  assert.equal(feedback.averageRating, 4.67);
  assert.deepEqual(feedback.ratingCounts, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 });
  assert.deepEqual(feedback.responses.map((response) => response.guestId), ["gst-2", "gst-1", "gst-3"]);
  assert.equal(feedback.responses[1].comment, "Useful conversations.");
  assert.equal(feedback.truncated, false);
});

test("bounds responses and ignores invalid ratings", () => {
  const feedback = normalizeEventFeedback({
    data: {
      num_responses: 4,
      survey_responses: [
        { guest_id: "gst-1", rating: 5 },
        { guest_id: "gst-2", rating: 4 },
        { guest_id: "gst-3", rating: 6 },
        { guest_id: "gst-4", rating: "bad" },
      ],
    },
  }, 2);

  assert.equal(feedback.responses.length, 2);
  assert.equal(feedback.totalResponses, 4);
  assert.equal(feedback.truncated, true);
  assert.equal(feedback.averageRating, 4.5);
});

test("normalizes and bounds event ids for bulk feedback", () => {
  assert.deepEqual(
    normalizeEventFeedbackIds([" evt-1 ", "evt-1", "evt-2", "bad id", null], 10),
    ["evt-1", "evt-2"],
  );
  assert.equal(
    normalizeEventFeedbackIds(Array.from({ length: 12 }, (_, index) => `evt-${index}`), 5).length,
    5,
  );
});

test("aggregates ratings and keeps source event context on responses", () => {
  const aggregate = aggregateEventFeedback([
    {
      eventId: "evt-1",
      eventTitle: "First event",
      eventDate: "2026-07-01",
      feedback: normalizeEventFeedback({
        num_responses: 2,
        survey_responses: [
          { id: "response-1", rating: 5, created_at: "2026-07-02T12:00:00.000Z" },
          { id: "response-2", rating: 4, created_at: "2026-07-01T12:00:00.000Z" },
        ],
      }),
    },
    {
      eventId: "evt-2",
      eventTitle: "Second event",
      eventDate: "2026-07-08",
      feedback: normalizeEventFeedback({
        num_responses: 1,
        survey_responses: [
          { id: "response-3", rating: 2, created_at: "2026-07-09T12:00:00.000Z" },
        ],
      }),
    },
  ]);

  assert.equal(aggregate.totalResponses, 3);
  assert.equal(aggregate.averageRating, 3.67);
  assert.deepEqual(aggregate.ratingCounts, { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 });
  assert.deepEqual(
    aggregate.responses.map((response) => [response.id, response.eventId]),
    [["response-3", "evt-2"], ["response-1", "evt-1"], ["response-2", "evt-1"]],
  );
  assert.deepEqual(
    aggregate.sources.map((source) => [source.eventTitle, source.totalResponses]),
    [["First event", 2], ["Second event", 1]],
  );
});
