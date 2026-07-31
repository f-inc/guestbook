export type EventFeedbackResponse = {
  id: string;
  guestId: string;
  name: string;
  email: string;
  rating: number;
  comment: string;
  createdAt: string;
  eventId?: string;
  eventTitle?: string;
  eventDate?: string;
};

export type EventFeedback = {
  responses: EventFeedbackResponse[];
  totalResponses: number;
  averageRating: number | null;
  ratingCounts: Record<1 | 2 | 3 | 4 | 5, number>;
  truncated: boolean;
};

export type EventFeedbackSource = {
  eventId: string;
  eventTitle: string;
  eventDate?: string;
  feedback: EventFeedback;
};

export type AggregatedEventFeedback = EventFeedback & {
  sources: Array<{
    eventId: string;
    eventTitle: string;
    eventDate: string;
    totalResponses: number;
    averageRating: number | null;
  }>;
};

const EMPTY_RATING_COUNTS: EventFeedback["ratingCounts"] = {
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
};

export function normalizeEventFeedback(payload: unknown, maximumResponses = 1_000): EventFeedback {
  const root = record(payload);
  const data = record(root.data);
  const rawResponses = firstArray(
    root.survey_responses,
    data.survey_responses,
    root.responses,
    data.responses,
  );
  const limit = Math.max(1, Math.min(5_000, Math.floor(maximumResponses) || 1_000));
  const responses = rawResponses
    .slice(0, limit)
    .map(normalizeFeedbackResponse)
    .filter((response): response is EventFeedbackResponse => Boolean(response))
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  const ratingCounts = { ...EMPTY_RATING_COUNTS };
  let ratingTotal = 0;

  responses.forEach((response) => {
    ratingCounts[response.rating as 1 | 2 | 3 | 4 | 5] += 1;
    ratingTotal += response.rating;
  });

  const upstreamTotal = finiteInteger(
    root.num_responses,
    data.num_responses,
    root.total_responses,
    data.total_responses,
  );
  const totalResponses = Math.max(rawResponses.length, upstreamTotal ?? 0);

  return {
    responses,
    totalResponses,
    averageRating: responses.length ? Number((ratingTotal / responses.length).toFixed(2)) : null,
    ratingCounts,
    truncated: totalResponses > responses.length,
  };
}

export function normalizeEventFeedbackIds(values: unknown, maximumEvents = 50) {
  if (!Array.isArray(values)) return [];
  const limit = Math.max(1, Math.min(100, Math.floor(maximumEvents) || 50));
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => /^[a-z0-9@._-]{1,160}$/i.test(value)))]
    .slice(0, limit);
}

export function aggregateEventFeedback(sources: EventFeedbackSource[]): AggregatedEventFeedback {
  const ratingCounts = { ...EMPTY_RATING_COUNTS };
  let totalResponses = 0;

  const normalizedSources = sources.map((source) => {
    const feedback = source.feedback;
    totalResponses += Math.max(0, Number(feedback.totalResponses) || 0);
    ([1, 2, 3, 4, 5] as const).forEach((rating) => {
      ratingCounts[rating] += Math.max(0, Number(feedback.ratingCounts?.[rating]) || 0);
    });
    return {
      eventId: source.eventId,
      eventTitle: source.eventTitle,
      eventDate: source.eventDate || "",
      totalResponses: Math.max(0, Number(feedback.totalResponses) || 0),
      averageRating: Number.isFinite(Number(feedback.averageRating))
        ? Number(feedback.averageRating)
        : null,
    };
  });

  const responses = sources
    .flatMap((source) => (source.feedback.responses || []).map((response) => ({
      ...response,
      eventId: source.eventId,
      eventTitle: source.eventTitle,
      eventDate: source.eventDate || "",
    })))
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  const ratedCount = ([1, 2, 3, 4, 5] as const)
    .reduce((sum, rating) => sum + ratingCounts[rating], 0);
  const ratingTotal = ([1, 2, 3, 4, 5] as const)
    .reduce((sum, rating) => sum + rating * ratingCounts[rating], 0);

  return {
    responses,
    totalResponses,
    averageRating: ratedCount ? Number((ratingTotal / ratedCount).toFixed(2)) : null,
    ratingCounts,
    truncated: sources.some((source) => source.feedback.truncated),
    sources: normalizedSources,
  };
}

function normalizeFeedbackResponse(value: unknown, index: number): EventFeedbackResponse | null {
  const response = record(value);
  const rating = Number(response.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;

  const guestId = boundedText(response.guest_id ?? response.guestId, 180);
  const createdAt = boundedText(response.created_at ?? response.createdAt, 80);
  const email = boundedText(response.email, 320);
  const name = boundedText(response.name, 240) || email || "Anonymous guest";
  const id = boundedText(response.id ?? response.api_id, 180)
    || guestId
    || `${email || "anonymous"}:${createdAt || index}:${rating}`;

  return {
    id,
    guestId,
    name,
    email,
    rating,
    comment: boundedText(response.feedback ?? response.comment, 10_000),
    createdAt,
  };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function firstArray(...values: unknown[]): unknown[] {
  return values.find(Array.isArray) as unknown[] || [];
}

function finiteInteger(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
