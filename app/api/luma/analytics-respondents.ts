import { normalizeMultiEventIds } from "./multi-event-stats";

export const ANALYTICS_RESPONDENT_PAGE_SIZE = 10;

export type AnalyticsRespondentQuery = {
  eventIds: string[];
  question: string;
  answer: string;
  cursor: number;
  pageSize: number;
};

export function parseAnalyticsRespondentQuery(params: URLSearchParams): AnalyticsRespondentQuery {
  return {
    eventIds: normalizeMultiEventIds(params.getAll("event_id")),
    question: boundedText(params.get("question"), 500),
    answer: boundedText(params.get("answer"), 500),
    cursor: boundedInteger(params.get("respondent_cursor"), 0, 1_000_000),
    pageSize: ANALYTICS_RESPONDENT_PAGE_SIZE,
  };
}

function boundedText(value: string | null, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength);
}

function boundedInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(0, parsed));
}
