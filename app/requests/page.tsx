"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Lock, RefreshCw } from "lucide-react";
import { submissionQuery, type Submission, type SubmissionsResponse } from "./answers";
import { readRequestsResponse } from "./response";
import { parseRequestsUrl, requestsUrl, type RequestsUrlState } from "./url";

import { CompanyIcon } from "./company-icon";
import { EventRequestDetail, requestTitle, requestAnswers, answerText, eventDate } from "./event-request-ui";

export default function RequestsPage() {
  const [key, setKey] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [authError, setAuthError] = useState("");
  const [checking, setChecking] = useState(true);
  const [searchDraft, setSearchDraft] = useState("");
  const [urlState, setUrlState] = useState<RequestsUrlState | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [result, setResult] = useState<(SubmissionsResponse & { search: string; offset: number }) | null>(null);
  const [linkedRequest, setLinkedRequest] = useState<Submission | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [lookupOffset, setLookupOffset] = useState(0);
  const [lookupNextOffset, setLookupNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const search = urlState?.search;
  const offset = urlState?.offset;
  const requestId = urlState?.requestId;
  const currentResult = result?.search === search && result?.offset === offset ? result : null;
  const selected = currentResult?.data.find(request => request.id === requestId)
    || (linkedRequest?.id === requestId ? linkedRequest : null);

  const navigate = useCallback((next: RequestsUrlState, replace = false, offsets?: number[]) => {
    window.history[replace ? "replaceState" : "pushState"]({
      ...window.history.state,
      ...(offsets ? { guestbookRequestOffsets: offsets } : {}),
    }, "", requestsUrl(window.location.href, next));
    setUrlState(next);
    if (offsets) setHistory(offsets);
  }, []);

  useEffect(() => {
    function restoreLocation() {
      const next = parseRequestsUrl(window.location.search);
      setUrlState(next);
      setSearchDraft(next.search);
      const offsets = window.history.state?.guestbookRequestOffsets;
      setHistory(Array.isArray(offsets) ? offsets.filter(value => Number.isSafeInteger(value) && value >= 0 && value < next.offset) : next.offset ? [0] : []);
    }
    restoreLocation();
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

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
    if (key === null || search === undefined || offset === undefined) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setResult(null); setLinkedRequest(null);
    void (async () => {
      try {
        const response = await fetch(`/api/campus/form-submissions?${submissionQuery(search, offset)}`, { headers: key ? { "x-guestbook-key": key } : {}, cache: "no-store", signal: controller.signal });
        if (response.status === 401 && !controller.signal.aborted) {
          setKey(null); setAuthError("Your session expired. Enter your Guestbook key.");
          return;
        }
        const body = await readRequestsResponse(response);
        if (!Array.isArray(body.data) || !body.pagination || !(body.pagination.nextOffset === null || (Number.isInteger(body.pagination.nextOffset) && body.pagination.nextOffset > offset))) throw new Error("Campus returned an invalid response.");
        if (!controller.signal.aborted) setResult({ ...body, search, offset });
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load requests."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [key, search, offset, revision]);

  useEffect(() => { setLookupOffset(0); }, [requestId, result]);

  useEffect(() => {
    setDetailError(""); setLookupNextOffset(null); setDetailLoading(false);
    if (key === null || !result || !urlState || result.search !== search || result.offset !== offset) return;
    if (!requestId) {
      if (result.data[0]) navigate({ ...urlState, requestId: result.data[0].id }, true);
      return;
    }
    if (result.data.some(request => request.id === requestId)) return;

    // New submissions can shift page offsets. Resolve the stable ID using the
    // existing bounded search, independently of the sidebar's current filters.
    const controller = new AbortController();
    setDetailLoading(true); setLinkedRequest(null);
    void (async () => {
      try {
        const response = await fetch(`/api/campus/form-submissions?${submissionQuery(requestId, lookupOffset)}`, { headers: key ? { "x-guestbook-key": key } : {}, cache: "no-store", signal: controller.signal });
        if (response.status === 401 && !controller.signal.aborted) {
          setKey(null); setAuthError("Your session expired. Enter your Guestbook key.");
          return;
        }
        const body = await readRequestsResponse(response);
        if (!Array.isArray(body.data) || !body.pagination || !(body.pagination.nextOffset === null || (Number.isSafeInteger(body.pagination.nextOffset) && body.pagination.nextOffset > lookupOffset))) throw new Error("Campus returned an invalid response.");
        if (controller.signal.aborted) return;
        const found = body.data.find(request => request.id === requestId);
        setLinkedRequest(found || null);
        if (!found) {
          setLookupNextOffset(body.pagination.nextOffset);
          setDetailError(body.pagination.nextOffset === null ? "This event request could not be found. It may have been removed." : "This event request was not found in this batch. Continue looking in older requests.");
        }
      } catch (cause) { if (!controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : "Unable to load this event request."); }
      finally { if (!controller.signal.aborted) setDetailLoading(false); }
    })();
    return () => controller.abort();
  }, [key, result, urlState, requestId, search, offset, lookupOffset, navigate]);

  function lock() {
    localStorage.removeItem("guestbook.key"); localStorage.removeItem("guestbook.sessionKey");
    for (const name of ["guestbook_key", "guestbook_session_key"]) document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
    setKey(null); setResult(null); setLinkedRequest(null); setDraftKey("");
  }

  if (key === null) return <main className="session-shell"><section className="session-panel"><div className="session-brand"><img className="brand-mark" src="/guestbook-logo.png" alt="" /><h1>Guestbook</h1></div><form className="session-form" onSubmit={event => { event.preventDefault(); void unlock(draftKey.trim()); }}><label>Guestbook key<input type="password" value={draftKey} onChange={event => setDraftKey(event.target.value)} autoComplete="current-password" required /></label>{authError && <p className="session-error" role="alert">{authError}</p>}<button className="button primary" disabled={checking}>{checking ? "Checking access…" : "Unlock Guestbook"}</button></form></section></main>;

  return <div className="app-shell submissions-shell requests-shell">
    <header className="topbar"><a href="/" className="brand-lockup flex items-center gap-2 no-underline"><img className="brand-mark size-11 object-contain" src="/guestbook-logo.png" alt="" /><h1 className="text-2xl font-bold">Guestbook</h1></a><nav className="topbar-actions" aria-label="Guestbook"><a className="button" href="/events">Events</a><a className="button" href="/guests">Guests</a><a className="button primary" href="/requests" aria-current="page"><FileText size={17} />Requests</a><button className="button" onClick={lock}><Lock size={17} />Lock</button></nav></header>
    <main className="submissions-content">
      <div className="submissions-grid" aria-busy={loading}>
        <aside className="panel submissions-results" aria-label="Requests">
          <div className="requests-sidebar-controls">
      <div className="submissions-heading"><div><h2>Requests</h2><p className="text-muted">Review event plans and organizers.</p></div><button className="button" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh</button></div>
      <form className="requests-filter" onSubmit={event => { event.preventDefault(); navigate({ search: searchDraft.trim().slice(0, 500), offset: 0, requestId: "" }, false, []); }}><label><span>Search requests</span><input type="search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="Search requests…" /></label><button className="button primary" disabled={loading}>Search</button>{search && <button type="button" className="button" disabled={loading} onClick={() => { setSearchDraft(""); navigate({ search: "", offset: 0, requestId: "" }, false, []); }}>Clear</button>}</form>
          </div>
          <div className="requests-sidebar-list">
          {loading && <p role="status">Loading requests…</p>}
          {error && <div role="alert"><p>{error}</p><button className="button" onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
          {result && !result.data.length && <p role="status">{result.pagination.nextOffset !== null ? "No matches in this batch. Continue to search more requests." : "No matching requests found."}</p>}
          {!!result?.data.length && <div className="request-inbox"><div className="request-inbox-heading"><h3>Event requests</h3><span className="count-pill">{result.data.length}</span></div>{result.data.map(request => {
            const answers = requestAnswers(request);
            return <button type="button" className={`request-card ${selected?.id === request.id ? "is-selected" : ""}`} key={request.id} aria-pressed={selected?.id === request.id} onClick={() => { if (request.id !== requestId) navigate({ ...urlState, requestId: request.id }); }}>
              <span className="request-card-top"><span className="request-title-with-icon"><CompanyIcon website={answers.companyUrl} linkedin={answers.companyLinkedin} company={answerText(answers.companyName, "?")} /><strong>{requestTitle(answers)}</strong></span><span aria-hidden="true">→</span></span>
              <span className="request-card-organizer">{answerText(answers.contactName, request.name || "Unknown organizer")}</span>
              <span className="request-card-date">{eventDate(answers.startAt)}</span>
              <span className="request-card-meta"><span>{answerText(answers.participantCount, "—")} attendees</span><span>{answerText(answers.budget, "Budget not provided")}</span></span>
              
            </button>;
          })}</div>}
          {result && (history.length > 0 || result.pagination.nextOffset !== null) && <div className="submissions-pagination"><span>{result.data.length ? `${result.data.length}` : "0"} requests</span><div className="flex gap-2"><button className="button" disabled={!history.length || loading} onClick={() => { navigate({ ...urlState, offset: history[history.length - 1], requestId: "" }, false, history.slice(0, -1)); }}>Previous</button><button className="button" disabled={result.pagination.nextOffset === null || loading} onClick={() => { if (result.pagination.nextOffset === null) return; navigate({ ...urlState, offset: result.pagination.nextOffset, requestId: "" }, false, [...history, offset]); }}>Next</button></div></div>}
          </div>
        </aside>
        <section className="panel submissions-detail" aria-label="Request details" aria-live="polite" aria-busy={loading || detailLoading}>{selected ? <EventRequestDetail request={selected} /> : loading || detailLoading ? <p role="status">Loading event request…</p> : detailError ? <div role="alert"><p>{detailError}</p><button className="button" onClick={() => lookupNextOffset !== null ? setLookupOffset(lookupNextOffset) : setRevision(value => value + 1)}>{lookupNextOffset !== null ? "Continue looking" : "Try again"}</button></div> : <div className="request-empty-detail"><FileText size={32} aria-hidden="true" /><h3>Select an event request</h3><p className="text-muted">Event plans and organizer details will appear here.</p></div>}</section>
      </div>
    </main>
  </div>;
}
