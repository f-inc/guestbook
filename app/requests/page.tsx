"use client";

import { useEffect, useState } from "react";
import { FileText, Lock, RefreshCw } from "lucide-react";
import { submissionQuery, type Submission, type SubmissionsResponse } from "./answers";

import { CompanyIcon } from "./company-icon";
import { EventRequestDetail, requestTitle, requestAnswers, answerText, eventDate } from "./event-request-ui";

export default function RequestsPage() {
  const [key, setKey] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [authError, setAuthError] = useState("");
  const [checking, setChecking] = useState(true);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState({ search: "", offset: 0 });
  const [history, setHistory] = useState<number[]>([]);
  const [result, setResult] = useState<SubmissionsResponse | null>(null);
  const [selected, setSelected] = useState<Submission | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  async function unlock(candidate: string) {
    setChecking(true); setAuthError("");
    try {
      const response = await fetch("/api/session", { headers: candidate ? { "x-guestbook-key": candidate } : {}, cache: "no-store" });
      if (!response.ok) throw new Error("Enter a valid Guestbook key to continue.");
      if (candidate) {
        localStorage.setItem("guestbook.key", candidate);
        localStorage.removeItem("guestbook.sessionKey");
        document.cookie = `guestbook_key=${encodeURIComponent(candidate)}; path=/; max-age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
      }
      setKey(candidate);
    } catch (cause) { setKey(null); setAuthError(cause instanceof Error ? cause.message : "Unable to verify access."); }
    finally { setChecking(false); }
  }
  useEffect(() => { void unlock(localStorage.getItem("guestbook.key") || localStorage.getItem("guestbook.sessionKey") || ""); }, []);
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setResult(null); setSelected(null);
    void (async () => {
      try {
        const response = await fetch(`/api/campus/form-submissions?${submissionQuery(query.search, query.offset)}`, { headers: key ? { "x-guestbook-key": key } : {}, cache: "no-store", signal: controller.signal });
        const body = await response.json() as SubmissionsResponse & { error?: string };
        if (!response.ok) {
          if (response.status === 401) { setKey(null); setAuthError("Your session expired. Enter your Guestbook key."); }
          throw new Error(body.error || "Unable to load requests.");
        }
        if (!Array.isArray(body.data) || !body.pagination || !(body.pagination.nextOffset === null || (Number.isInteger(body.pagination.nextOffset) && body.pagination.nextOffset > query.offset))) throw new Error("Campus returned an invalid response.");
        if (!controller.signal.aborted) { setResult(body); setSelected(body.data[0] || null); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load requests."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [key, query, revision]);

  function lock() {
    localStorage.removeItem("guestbook.key"); localStorage.removeItem("guestbook.sessionKey");
    for (const name of ["guestbook_key", "guestbook_session_key"]) document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
    setKey(null); setResult(null); setSelected(null); setDraftKey("");
  }

  if (key === null) return <main className="session-shell"><section className="session-panel"><div className="session-brand"><img className="brand-mark" src="/guestbook-logo.png" alt="" /><h1>Guestbook</h1></div><form className="session-form" onSubmit={event => { event.preventDefault(); void unlock(draftKey.trim()); }}><label>Guestbook key<input type="password" value={draftKey} onChange={event => setDraftKey(event.target.value)} autoComplete="current-password" required /></label>{authError && <p className="session-error" role="alert">{authError}</p>}<button className="button primary" disabled={checking}>{checking ? "Checking access…" : "Unlock Guestbook"}</button></form></section></main>;

  return <div className="app-shell submissions-shell">
    <header className="topbar"><a href="/" className="brand-lockup flex items-center gap-2 no-underline"><img className="brand-mark size-11 object-contain" src="/guestbook-logo.png" alt="" /><h1 className="text-2xl font-bold">Guestbook</h1></a><nav className="topbar-actions" aria-label="Guestbook"><a className="button" href="/events">Events</a><a className="button" href="/guests">Guests</a><a className="button primary" href="/requests" aria-current="page"><FileText size={17} />Requests</a><button className="button" onClick={lock}><Lock size={17} />Lock</button></nav></header>
    <main className="submissions-content">
      <div className="submissions-heading"><div><span className="eyebrow">Campus OS</span><h2>Requests</h2><p className="text-muted">Review event plans, space needs, and organizer details.</p></div><button className="button" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh</button></div>
      <form className="requests-filter" onSubmit={event => { event.preventDefault(); setHistory([]); setQuery({ search: searchDraft.trim(), offset: 0 }); }}><label><span>Search requests</span><input type="search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="Search any submitted field…" /></label><button className="button primary" disabled={loading}>Search</button>{query.search && <button type="button" className="button" disabled={loading} onClick={() => { setSearchDraft(""); setHistory([]); setQuery({ search: "", offset: 0 }); }}>Clear</button>}</form>
      <div className="submissions-grid" aria-busy={loading}>
        <section className="panel submissions-results" aria-label="Requests">
          {loading && <p role="status">Loading requests…</p>}
          {error && <div role="alert"><p>{error}</p><button className="button" onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
          {result && !result.data.length && <p role="status">{result.pagination.nextOffset !== null ? "No matches in this batch. Continue to search more requests." : "No matching requests found."}</p>}
          {!!result?.data.length && <div className="request-inbox"><div className="request-inbox-heading"><h3>Event requests</h3><span className="count-pill">{result.data.length}</span></div>{result.data.map(request => {
            const answers = requestAnswers(request);
            return <button type="button" className={`request-card ${selected?.id === request.id ? "is-selected" : ""}`} key={request.id} aria-pressed={selected?.id === request.id} onClick={() => setSelected(request)}>
              <span className="request-card-top"><span className="request-title-with-icon"><CompanyIcon website={answers.companyUrl} linkedin={answers.companyLinkedin} company={answerText(answers.companyName, "?")} /><strong>{requestTitle(answers)}</strong></span><span aria-hidden="true">→</span></span>
              <span className="request-card-organizer">{answerText(answers.contactName, request.name || "Unknown organizer")}</span>
              <span className="request-card-date">{eventDate(answers.startAt)}</span>
              <span className="request-card-meta"><span>{answerText(answers.participantCount, "—")} attendees</span><span>{answerText(answers.budget, "Budget not provided")}</span></span>
              
            </button>;
          })}</div>}
          {result && (history.length > 0 || result.pagination.nextOffset !== null) && <div className="submissions-pagination"><span>{result.data.length ? `${result.data.length}` : "0"} requests</span><div className="flex gap-2"><button className="button" disabled={!history.length || loading} onClick={() => { const offset = history[history.length - 1]; setHistory(history.slice(0, -1)); setQuery({ ...query, offset }); }}>Previous</button><button className="button" disabled={result.pagination.nextOffset === null || loading} onClick={() => { if (result.pagination.nextOffset === null) return; setHistory([...history, query.offset]); setQuery({ ...query, offset: result.pagination.nextOffset }); }}>Next</button></div></div>}
        </section>
        <section className="panel submissions-detail" aria-label="Request details" aria-live="polite">{selected ? <EventRequestDetail request={selected} /> : <div className="request-empty-detail"><FileText size={32} aria-hidden="true" /><h3>Select an event request</h3><p className="text-muted">Event plans and organizer details will appear here.</p></div>}</section>
      </div>
    </main>
  </div>;
}
