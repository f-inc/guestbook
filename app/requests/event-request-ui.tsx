import { CalendarDays, Users, Wallet, ExternalLink, Mail, Phone, Building2 } from "lucide-react";
import { CompanyIcon } from "./company-icon";
import { AnswerValue, type Submission } from "./answers";

export function requestAnswers(request: Submission): Record<string, unknown> {
  return request.answers && typeof request.answers === "object" && !Array.isArray(request.answers) ? request.answers as Record<string, unknown> : {};
}
export function answerText(value: unknown, fallback = "Not provided"): string {
  return typeof value === "string" && value.trim() ? value : typeof value === "number" ? value.toLocaleString() : fallback;
}
export function eventDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not provided";
  // Campus datetime-local answers represent wall time in the supplied zone, not UTC.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(value);
  if (match) {
    const parsed = new Date(`${match[1]}T${match[2]}:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return value;
}
function SafeLink({ value, children }: { value: unknown; children: string }) {
  const text = answerText(value);
  try {
    const url = new URL(text);
    if (["http:", "https:"].includes(url.protocol)) return <a className="request-link" href={url.href} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={14} aria-hidden="true" /></a>;
  } catch {}
  return <span className="submission-answer-text">{text}</span>;
}
export function requestTitle(answers: Record<string, unknown>): string {
  const company = answerText(answers.companyName, "Event request");
  const event = answerText(answers.eventName, "");
  return event ? `${company} - ${event}` : company;
}
const knownFields = new Set(["companyName", "companyUrl", "companyLinkedin", "contactLinkedin", "contactName", "contactTitle", "contactEmail", "contactMobile", "eventName", "eventLink", "participantCount", "startAt", "endAt", "timeZone", "specialRequests", "budget"]);

// Explicit IDs of the initial example submissions; company names can also belong to real requests.
const sampleRequestIds = new Set([
  "beac0abb-a39a-4321-b05e-1eb29d17db8c",
  "01c34980-0012-4171-8e9b-0cad69e16827",
  "e72bac01-f5d9-4f36-a7aa-640862bbfea2",
]);

export function EventRequestDetail({ request }: { request: Submission }) {
  const answers = requestAnswers(request);
  const extra = Object.fromEntries(Object.entries(answers).filter(([field]) => !knownFields.has(field)));
  return <>
    <div className="request-detail-header"><div className="request-detail-title"><span className="eyebrow">Event request</span><div className="request-title-with-icon"><CompanyIcon website={answers.companyUrl} linkedin={answers.companyLinkedin} company={answerText(answers.companyName, "?")} /><h2>{requestTitle(answers)}</h2>{sampleRequestIds.has(request.id) && <span className="request-sample-badge">Sample</span>}</div><p>Submitted by {answerText(answers.contactName, request.name || "Unknown organizer")}</p></div><div className="request-detail-action"><SafeLink value={answers.eventLink}>Open event document</SafeLink></div></div>
    <div className="request-summary">
      <div><CalendarDays size={19} aria-hidden="true" /><span>Event schedule</span><strong>{eventDate(answers.startAt)}</strong><small>Ends {eventDate(answers.endAt)}</small><small>{answerText(answers.timeZone)}</small></div>
      <div><Users size={19} aria-hidden="true" /><span>Expected attendance</span><strong>{answerText(answers.participantCount)}<small> participants</small></strong></div>
      <div><Wallet size={19} aria-hidden="true" /><span>Space budget</span><strong>{answerText(answers.budget)}</strong></div>
    </div>
    <section className="request-section"><h3>Equipment & special requests</h3><p className="request-notes">{answerText(answers.specialRequests, "No special requests provided.")}</p></section>
    <section className="request-section"><h3>Organizer</h3><div className="request-contact"><div className="request-avatar" aria-hidden="true">{answerText(answers.contactName, request.name || "?").slice(0, 1).toUpperCase()}</div><div><strong>{answerText(answers.contactName, request.name || "Unknown organizer")}</strong><p>{answerText(answers.contactTitle)}</p></div></div><dl className="request-fields"><div><dt><Building2 size={14} />Company</dt><dd>{answerText(answers.companyName)}</dd></div><div><dt>Website</dt><dd><SafeLink value={answers.companyUrl}>Visit company website</SafeLink></dd></div><div><dt>Company LinkedIn</dt><dd><SafeLink value={answers.companyLinkedin}>View company on LinkedIn</SafeLink></dd></div><div><dt>Organizer LinkedIn</dt><dd><SafeLink value={answers.contactLinkedin}>View organizer profile</SafeLink></dd></div><div><dt><Mail size={14} />Email</dt><dd>{answerText(answers.contactEmail, request.email || "Not provided")}</dd></div><div><dt><Phone size={14} />Mobile</dt><dd>{answerText(answers.contactMobile)}</dd></div></dl></section>
    {!!Object.keys(extra).length && <section className="request-section"><h3>Additional answers</h3><AnswerValue value={extra} /></section>}
    {!Object.keys(answers).length && <section className="request-section"><h3>Original answers</h3><AnswerValue value={request.answers} /></section>}
    <details className="request-record"><summary>Request record</summary><dl className="request-fields"><div><dt>Received</dt><dd>{new Date(request.created_at).toLocaleString()}</dd></div><div><dt>Form version</dt><dd>{request.form_version}</dd></div><div><dt>Request ID</dt><dd>{request.id}</dd></div></dl></details>
  </>;
}
