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


test("uses Luma's complete summary when only commented responses are returned", () => {
  const feedback = normalizeEventFeedback({
    num_responses: 9,
    average_rating: 5,
    rating_counts: [
      { rating: 5, count: 9 },
      { rating: 4, count: 0 },
      { rating: 3, count: 0 },
      { rating: 2, count: 0 },
      { rating: 1, count: 0 },
    ],
    survey_responses: Array.from({ length: 3 }, (_, index) => ({
      id: `comment-${index}`, rating: 5, feedback: "Great event",
    })),
  });
  assert.equal(feedback.totalResponses, 9);
  assert.equal(feedback.averageRating, 5);
  assert.deepEqual(feedback.ratingCounts, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 9 });
  assert.equal(feedback.responses.length, 3);
  assert.equal(feedback.truncated, true);
});

test("partial response cards and display caps do not change the full rating distribution", () => {
  const feedback = normalizeEventFeedback({
    data: {
      num_responses: 8,
      average_rating: 4.375,
      rating_counts: [{ rating: 5, count: 3 }, { rating: 4, count: 5 }],
      survey_responses: [{ rating: 5 }, { rating: 5 }, { rating: 5 }],
    },
  }, 1);
  assert.equal(feedback.totalResponses, 8);
  assert.equal(feedback.responses.length, 1);
  assert.equal(feedback.averageRating, 4.38);
  assert.deepEqual(feedback.ratingCounts, { 1: 0, 2: 0, 3: 0, 4: 5, 5: 3 });
});

test("keeps full rating summaries without individual response cards", () => {
  const feedback = normalizeEventFeedback({
    num_responses: 8,
    average_rating: null,
    rating_counts: [{ rating: 5, count: 3 }, { rating: 4, count: 5 }],
    survey_responses: [],
  });
  assert.equal(feedback.totalResponses, 8);
  assert.equal(feedback.averageRating, 4.38);
  assert.equal(feedback.ratingCounts[4], 5);
  assert.equal(feedback.responses.length, 0);
});

test("invalid summary fields fall back to the available response ratings", () => {
  for (const rating_counts of [
    undefined, [], [{ rating: 6, count: 8 }], [{ rating: 5, count: -1 }],
    [{ rating: 5, count: 1.5 }], [{ rating: 5, count: null }],
    [{ rating: 5, count: 2 }, { rating: 5, count: 2 }],
  ]) {
    const feedback = normalizeEventFeedback({
      num_responses: 2,
      average_rating: 9,
      rating_counts,
      survey_responses: [{ rating: 4 }, { rating: 5 }],
    });
    assert.equal(feedback.averageRating, 4.5);
    assert.deepEqual(feedback.ratingCounts, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  }
});

test("combined feedback weights all ratings rather than available response cards", () => {
  const aggregate = aggregateEventFeedback([
    {
      eventId: "evt-many", eventTitle: "Eight ratings",
      feedback: normalizeEventFeedback({
        num_responses: 8, average_rating: 4.375,
        rating_counts: [{ rating: 5, count: 3 }, { rating: 4, count: 5 }],
        survey_responses: [{ id: "one-card", rating: 5 }],
      }),
    },
    {
      eventId: "evt-few", eventTitle: "Two ratings",
      feedback: normalizeEventFeedback({
        num_responses: 2, average_rating: 1,
        rating_counts: [{ rating: 1, count: 2 }],
        survey_responses: [{ id: "second-card", rating: 1 }],
      }),
    },
  ]);
  assert.equal(aggregate.totalResponses, 10);
  assert.equal(aggregate.averageRating, 3.7);
  assert.deepEqual(aggregate.ratingCounts, { 1: 2, 2: 0, 3: 0, 4: 5, 5: 3 });
  assert.equal(aggregate.responses.length, 2);
  assert.equal(aggregate.truncated, true);
});
