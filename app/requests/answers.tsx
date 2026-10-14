import type { ReactNode } from "react";

export type Submission = { id: string; form_key: string; form_version: number; created_at: string; name: string | null; email: string | null; answers: unknown };
export type SubmissionsResponse = { data: Submission[]; pagination: { limit: number; offset: number; nextOffset: number | null } };

export function submissionQuery(search: string, offset: number) {
  const query = new URLSearchParams({ formKey: "event-request", limit: "25", offset: String(offset) });
  if (search.trim()) query.set("q", search.trim());
  return query.toString();
}

export function AnswerValue({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span className="text-muted">Not provided (null)</span>;
  if (Array.isArray(value)) return value.length ? <ol className="submission-answer-list">{value.map((item, index) => <li key={index}><AnswerValue value={item} /></li>)}</ol> : <span>Empty list</span>;
  if (typeof value === "object" && value) {
    const entries = Object.entries(value);
    return entries.length ? <dl className="submission-answers">{entries.map(([key, item]) => <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ")}</dt><dd><AnswerValue value={item} /></dd></div>)}</dl> : <span>No answers</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "Yes (true)" : "No (false)"}</span>;
  return <span className="submission-answer-text">{value === "" ? "Empty response" : String(value)}</span>;
}
