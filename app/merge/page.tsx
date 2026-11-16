"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeSocial, type MergeCandidate, type MergeProfile, type MergeSignal } from "../api/luma/merge-matching";
import styles from "./page.module.css";
import { MergeQueue, holdsProfiles, isOutstanding, type MergeJob } from "./merge-queue";

type Operation = { id: string; after: Array<{ personId: string; canonicalId: string }>; createdAt: string; undoneAt: string | null };
type Station = { mergeEnabled: boolean; profiles: MergeProfile[]; candidates: MergeCandidate[]; truncated: boolean; operations: Operation[];
  coverage: { scannedPeople: number; peopleTruncated: boolean; registrationsTruncated: boolean; registrationsPerPerson: number; candidateLimit: number; accountsTruncated?:boolean } };
type Preview = { accounts?: Array<{personId:string;account:{name:string;email:string|null;lumaUserId:string|null;phoneNumber:string|null}}>; people: Array<MergeProfile & { comments: Array<{ id: string; body: string; author: string }> }>;
  events: Array<{ eventId: string; title: string; attended: boolean; emails: string[]; registrations: number }>;
  registrationsTruncated: boolean; commentsTruncated: boolean };
function jobMessage(job: MergeJob, now = Date.now()) {
  if (job.status === "waiting") { const seconds = Math.max(0, Math.ceil((job.notBefore! - now) / 1000)); return seconds ? `Merging in ${seconds}s` : "Waiting to save"; }
  if (job.status === "cancelled") return "Merge cancelled. Profiles restored.";
  if (job.status === "undone") return "Merge undone. Profiles restored.";
  if (job.status === "uncertain") return "Connection interrupted. Check or retry this decision safely.";
  if (job.undoRequested || job.status === "undoing") return "Undo queued. You can keep reviewing.";
  if (job.status === "failed") return "Merge failed. Profiles restored.";
  if (job.error && job.phase === "undo") return "Undo failed. This merge is still saved.";
  if (job.status === "saved") return "Profiles merged. History combined.";
  return "Merge queued. You can keep reviewing.";
}
function socialProfiles(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.flatMap(link => typeof link === "string" ? [link] : typeof link?.url === "string" ? [link.url] : []).join(" · ");
}
function profileSocialLinks(profile: MergeProfile | undefined, candidate: MergeCandidate) {
  const values = Array.isArray(profile?.socialLinks) ? profile.socialLinks.flatMap(link => typeof link === "string" ? [link] : typeof link?.url === "string" ? [link.url] : []) : [];
  // Social evidence matches both profiles, including links found only on their registrations.
  const shared = candidate.evidence.filter(evidence => evidence.signal === "social").map(evidence => evidence.value);
  return [...new Map([...values, ...shared].map(mergeSocial).filter(Boolean).map(link => [link!.key, {
    href: `https://${link!.key}`, label: link!.key.startsWith("linkedin.com/") ? "LinkedIn" : "Twitter/X",
  }])).values()];
}
const statusLabels: Record<MergeJob["status"], string> = { waiting: "Pending confirmation", queued: "Queued", saving: "Saving", saved: "Merged", undoing: "Undoing", undone: "Undone", cancelled: "Cancelled", failed: "Failed", uncertain: "Needs attention" };
const labels: Record<MergeSignal, string> = { name: "First + last name", social: "LinkedIn / Twitter", phone: "Phone number" };
export default function MergeStation() {
  const loadRevision = useRef(0);
  const queueRef = useRef<MergeQueue | null>(null);
  const [jobs, setJobs] = useState<MergeJob[]>([]);
  const [queueReady, setQueueReady] = useState(false);
  const [toastJobId, setToastJobId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef(new Map<string, HTMLElement>());
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"review" | "history">("review");
  const [historySearch, setHistorySearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [data, setData] = useState<Station | null>(null);
  const [filters, setFilters] = useState<MergeSignal[]>(["name", "social", "phone"]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MergeCandidate | null>(null);
  const [previewState, setPreviewState] = useState<{ pair: MergeCandidate; value: Preview } | null>(null);
  const detail = previewState?.pair === selected ? previewState.value : null;
  const [primaryChoices, setPrimaryChoices] = useState<Record<string, string>>({});
  const setPrimary = (id: string) => { if (selected) setPrimaryChoices(choices => ({ ...choices, [JSON.stringify([selected.left, selected.right])]: id })); };
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const waiting = jobs.filter(job => job.status === "waiting");
  const outstanding = jobs.filter(isOutstanding);
  const busy = outstanding.length > 0;
  const hasStartedWork = outstanding.some(job => job.status !== "waiting");
  const toastJob = jobs.find(job => job.id === toastJobId);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [checked, setChecked] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!waiting.length) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 100);
    return () => clearInterval(timer);
  }, [waiting.length]);
  const request = useCallback(async (suffix = "", init: RequestInit = {}) => {
    const response = await fetch(`/api/people/merge${suffix}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(key ? { "x-guestbook-key": key } : {}), ...init.headers } });
    const body = await response.json() as Station & Preview & { error?: string; id?: string; classificationPending?: boolean };
    if (response.status === 401) setAuthorized(false);
    if (!response.ok) throw Object.assign(new Error(body.error || "Unable to complete this request."), { status: response.status });
    return body;
  }, [key]);
  useEffect(() => {
    if (!authorized) return;
    const storageKey = "guestbook.merge-outbox.v1";
    let cancelled = false;
    let release: (() => void) | undefined;
    const initialize = () => {
    try {
      const restored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      const statuses = ["queued", "saving", "saved", "undoing", "undone", "cancelled", "failed", "uncertain"];
      if (!Array.isArray(restored) || restored.some(job => !job || !statuses.includes(job.status) ||
          ![job.id, job.left, job.right, job.primary, job.createdAt].every(value => typeof value === "string") ||
          !Array.isArray(job.reviewedPersonIds) || !job.reviewedPersonIds.length || job.reviewedPersonIds.length > 100 ||
          !job.reviewedPersonIds.every(value => typeof value === "string"))) throw new Error("The saved merge queue could not be read. Do not clear browser storage while decisions are pending.");
      let previousStatuses = new Map<string, MergeJob["status"]>(restored.map((job: MergeJob) => [job.id, job.status]));
      const queue = new MergeQueue({
        persist: next => localStorage.setItem(storageKey, JSON.stringify(next)),
        publish: next => {
          setJobs(next);
          const finished = next.find(job => ["saved", "failed", "uncertain"].includes(job.status) && previousStatuses.get(job.id) === "saving");
          if (finished) setToastJobId(finished.id);
          previousStatuses = new Map(next.map(job => [job.id, job.status]));
        },
        merge: async job => {
          const saved = await request("", { method: "POST", body: JSON.stringify({ left: job.left, right: job.right, primary: job.primary, reviewedPersonIds: job.reviewedPersonIds, operationId: job.id }) });
          return { id: saved.id!, undone: (saved as any).undone };
        },
        undo: id => request("", { method: "DELETE", body: JSON.stringify({ id }) }),
      }, restored);
      queueRef.current = queue;
      queue.start(); setQueueReady(true);
    } catch (cause) { setQueueReady(false); setError((cause as Error).message); }
    };
    // Only one station tab may own the browser outbox; otherwise tabs can overwrite unsent decisions.
    if (!navigator.locks) { setError("This browser cannot safely own the merge queue. Open the station in a current browser."); return; }
    void navigator.locks.request("guestbook-merge-outbox", { ifAvailable: true }, async lock => {
      if (cancelled) return;
      if (!lock) { setError("The merge queue is active in another tab. Close that station tab and reload this page to review here."); return; }
      initialize();
      await new Promise<void>(resolve => { release = resolve; if (cancelled) resolve(); });
    }).catch(cause => setError((cause as Error).message));
    return () => { cancelled = true; queueRef.current?.stop(); queueRef.current = null; setQueueReady(false); release?.(); };
  }, [authorized, request]);
  useEffect(() => {
    if (!hasStartedWork) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasStartedWork]);
  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    if (!filters.length) { setSelected(null); setLoading(false); return; }
    setLoading(true); setError("");
    const query = new URLSearchParams(); filters.forEach(signal => query.append("signal", signal));
    try { const result = await request(`?${query}`); if (revision === loadRevision.current) setData(result); }
    catch (cause) { if (revision === loadRevision.current) setError((cause as Error).message); }
    finally { if (revision === loadRevision.current) setLoading(false); }
  }, [request, filters]);
  async function unlock(candidate: string, initial = false) {
    try {
      const response = await fetch("/api/session", { headers: candidate ? { "x-guestbook-key": candidate } : {} });
      if (!response.ok) throw new Error("Enter a valid Guestbook key.");
      if (candidate) localStorage.setItem("guestbook.key", candidate);
      setKey(candidate); setAuthorized(true); setError("");
    } catch (cause) { if (!initial || candidate) setError((cause as Error).message); }
    finally { setChecked(true); }
  }
  useEffect(() => { void unlock(localStorage.getItem("guestbook.key") || localStorage.getItem("guestbook.sessionKey") || "", true); }, []);
  useEffect(() => { if (authorized) void load(); }, [authorized, load]);
  useEffect(() => {
    setPreviewState(null); setPreviewError("");
    if (!selected) return;
    const controller = new AbortController();
    const query = new URLSearchParams(); query.append("personId", selected.left); query.append("personId", selected.right);
    request(`?${query}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setPreviewState({ pair: selected, value: result }); })
      .catch(cause => { if (!controller.signal.aborted) setPreviewError(cause.message); });
    return () => controller.abort();
  }, [selected, request]);
  const people = useMemo(() => new Map(data?.profiles.map(p => [p.personId, p]) || []), [data]);
  const reservedPeople = useMemo(() => new Set(jobs.filter(holdsProfiles).flatMap(job => job.reviewedPersonIds)), [jobs]);
  const candidates = useMemo(() => data?.candidates.filter(c => !reservedPeople.has(c.left) && !reservedPeople.has(c.right)).filter(c => c.evidence.some(e => filters.includes(e.signal)))
    .filter(c => !search.trim() || [people.get(c.left), people.get(c.right)].some(p => `${p?.name} ${p?.email}`.toLowerCase().includes(search.trim().toLowerCase()))) || [], [data, filters, people, search, reservedPeople]);
  const matchCounts = useMemo(() => ({
    profiles: new Set(candidates.flatMap(candidate => [candidate.left, candidate.right])).size,
    signals: (Object.keys(labels) as MergeSignal[]).map(signal => ({
      signal,
      count: candidates.filter(candidate => candidate.evidence.some(e => e.signal === signal)).length,
    })),
  }), [candidates]);
  const history = useMemo(() => {
    const decisions = new Map<string, { id: string; members: string[]; primary: string; createdAt: string; status: MergeJob["status"]; job?: MergeJob; operation?: Operation }>();
    for (const operation of data?.operations || []) decisions.set(operation.id, {
      id: operation.id, members: operation.after.map(member => member.personId), primary: operation.after[0]?.canonicalId,
      createdAt: operation.createdAt, status: operation.undoneAt ? "undone" : "saved", operation,
    });
    for (const job of jobs) decisions.set(job.id, {
      id: job.id, members: job.reviewedPersonIds, primary: job.primary, createdAt: job.createdAt,
      status: job.status, job,
    });
    return [...decisions.values()].filter(row => row.status === "saved" && !row.job?.undoRequested).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [jobs, data?.operations]);
  const visibleHistory = history.filter(row => !historySearch.trim() || row.members.some(id => `${people.get(id)?.name || ""} ${people.get(id)?.email || ""}`.toLowerCase().includes(historySearch.trim().toLowerCase())));
  useEffect(() => {
    if (!loading && (!selected || !candidates.some(c => c.left === selected.left && c.right === selected.right))) {
      setSelected(candidates[0] || null);
    }
  }, [candidates, loading, selected]);
  function merge(candidate = selected) {
    if (loading || !candidate || !data?.mergeEnabled || !queueReady || !queueRef.current) return;
    const reviewed = candidate === selected && detail ? detail.people.map(p => p.personId) : [candidate.left, candidate.right];
    const id = crypto.randomUUID();
    try {
      const queued = queueRef.current.enqueue({ id, left: candidate.left, right: candidate.right,
        primary: primaryChoices[JSON.stringify([candidate.left, candidate.right])] || candidate.left,
        reviewedPersonIds: reviewed, createdAt: new Date().toISOString() });
      if (queued) {
        const members = new Set(reviewed);
        const remaining = candidates.filter(pair => !members.has(pair.left) && !members.has(pair.right));
        setSelected(remaining[Math.min(candidates.indexOf(candidate), remaining.length - 1)] || null);
        setToastJobId(id); setError("");
      }
    } catch { setError("Unable to save the merge queue in this browser. No new merge was sent. Check available browser storage and try again."); }
  }
  function undoJob(id: string) {
    try { queueRef.current?.undo(id); setToastJobId(null); }
    catch (cause) { setError((cause as Error).message); }
  }
  function retryJob(id: string) {
    try { queueRef.current?.retry(id); }
    catch (cause) { setError((cause as Error).message); }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (!authorized || event.repeat || target.isContentEditable || target.closest("input:not([type=radio]):not([type=checkbox]), textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      if (event.metaKey && event.key.toLowerCase() === "z" && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        const latest = [...jobs].reverse().find(job => job.status === "waiting");
        if (latest) { event.preventDefault(); undoJob(latest.id); }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (tab !== "review" && event.key !== "/") return;
      const index = selected ? candidates.indexOf(selected) : -1;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const next = candidates[Math.max(0, Math.min(candidates.length - 1, index + (event.key === "j" ? 1 : -1)))];
        if (next) { setSelected(next); const row = cardsRef.current.get(JSON.stringify([next.left, next.right])); row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
      } else if (event.key === "m") { event.preventDefault(); void merge(); }
      else if (event.key === "1" && selected) setPrimary(selected.left);
      else if (event.key === "2" && selected) setPrimary(selected.right);
      else if (event.key === "e") setExpanded(value => !value);
      else if (event.key === "/") { event.preventDefault(); setFiltersOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  return <div className={styles.station}>
    <header className={styles.header}>
      <a href="/" className={styles.brand}><img src="/guestbook-logo.png" alt="" width="25" height="25" />Guestbook</a>
      <button type="button" className={styles.filterToggle} aria-expanded={filtersOpen} aria-controls="merge-filters" onClick={() => setFiltersOpen(value => !value)}>Filters</button><nav aria-label="Guestbook"><a href="/events">Events</a><a href="/guests">Guests</a><a href="/merge" aria-current="page">Merge station</a></nav>
    </header>
    {!checked ? <p className={styles.access} role="status">Checking access…</p> : !authorized ? <form onSubmit={event => { event.preventDefault(); void unlock(draft); }} className={styles.access}>
      <h1>Merge station</h1>{error && <p role="alert">{error}</p>}<label>Guestbook key<input type="password" autoComplete="current-password" value={draft} onChange={event => setDraft(event.target.value)} /></label><button className="button primary">Unlock</button>
    </form> : <div className={styles.workspace}>
      <aside id="merge-filters" data-open={filtersOpen} className={styles.sidebar} aria-label="Merge filters">
        <div className={styles.sidebarHeading}><h1>Merge station</h1><p>Review identities. Combine histories.</p></div>
        <label className={styles.search}>Search {tab === "review" ? "matches" : "history"}<input ref={searchRef} type="search" placeholder="Name or email" value={tab === "review" ? search : historySearch} onChange={event => tab === "review" ? setSearch(event.target.value) : setHistorySearch(event.target.value)} /></label>
        {tab === "review" ? <>
          <section className={styles.filterSection}><h2>Matching rules</h2>{matchCounts.signals.map(({ signal, count }) => <label className={styles.filter} key={signal}>
            <input type="checkbox" checked={filters.includes(signal)} disabled={busy} onChange={() => { setFilters(old => old.includes(signal) ? old.filter(value => value !== signal) : [...old, signal]); setSelected(null); }} /><span>{labels[signal]}</span><small>{count.toLocaleString()}</small>
          </label>)}<p>Any selected rule. Counts overlap within loaded results.</p></section>
          <section className={styles.filterSection}><h2>Scan coverage</h2><dl className={styles.coverage}>
            <div><dt>Profiles scanned</dt><dd>{data?.coverage.scannedPeople.toLocaleString() || "—"}</dd></div>
            <div><dt>Pairs loaded</dt><dd>{data?.candidates.length.toLocaleString() || "—"}</dd></div>
            <div><dt>Profiles in results</dt><dd>{matchCounts.profiles.toLocaleString()}</dd></div>
          </dl>
          {data && (data.truncated || data.coverage.peopleTruncated || data.coverage.registrationsTruncated || data.coverage.accountsTruncated) && <p className={styles.partial}>Partial scan · up to 10,000 profiles, 1,000 pairs, and {data.coverage.registrationsPerPerson} recent registrations per profile.</p>}
          <details className={styles.ruleHelp}><summary>How matching works</summary><p>Names can match across profiles, emails, and registration answers. Social profiles must match exactly and contain each profile’s first name. Phones are normalized, including US +1.</p></details></section>
        </> : <section className={styles.filterSection}><h2>Completed merges</h2><p>Only successfully saved merges appear here. Pending confirmations and cancelled actions are excluded.</p><p>Latest 20 saved operations across users, plus recent merges from this browser.</p></section>}
        {!!waiting.length && <section className={styles.filterSection}><h2>Undo window</h2>{waiting.map(job => <div className={styles.pendingDraft} key={job.id}><span>{people.get(job.primary)?.name || "Pending merge"}<small>{jobMessage(job, clock)}</small></span><button type="button" className={styles.detailButton} onClick={() => undoJob(job.id)}>Undo</button></div>)}</section>}
        {jobs.some(job => job.status === "failed" || job.status === "uncertain") && <section className={styles.filterSection}><h2>Needs attention</h2>{jobs.filter(job => job.status === "failed" || job.status === "uncertain").map(job => <div className={styles.pendingDraft} key={job.id}><span>{people.get(job.primary)?.name || "Merge"}<small>{job.error || jobMessage(job)}</small></span>{job.status === "uncertain" && <button type="button" className={styles.detailButton} onClick={() => retryJob(job.id)}>Retry</button>}</div>)}</section>}

        <section className={styles.filterSection}><h2>Keyboard shortcuts</h2><dl className={styles.shortcuts}>
          <div><dt>Next / previous</dt><dd><kbd>J</kbd> <kbd>K</kbd></dd></div><div><dt>Choose main profile</dt><dd><kbd>1</kbd> <kbd>2</kbd></dd></div><div><dt>Confirm match</dt><dd><kbd>M</kbd></dd></div><div><dt>Undo pending merge</dt><dd><kbd>⌘Z</kbd></dd></div><div><dt>Expand details</dt><dd><kbd>E</kbd></dd></div><div><dt>Search</dt><dd><kbd>/</kbd></dd></div>
        </dl></section>
      </aside>
      <main className={styles.main}>
        <div className={styles.tabBar}><div role="tablist" aria-label="Merge station views" className={styles.tabs}>
          <button type="button" id="review-tab" role="tab" aria-selected={tab === "review"} aria-controls="review-panel" tabIndex={tab === "review" ? 0 : -1} onKeyDown={event => { if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); setTab("history"); document.getElementById("history-tab")?.focus(); } }} onClick={() => setTab("review")}>To review <span>{candidates.length.toLocaleString()}</span></button>
          <button type="button" id="history-tab" role="tab" aria-selected={tab === "history"} aria-controls="history-panel" tabIndex={tab === "history" ? 0 : -1} onKeyDown={event => { if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); setTab("review"); document.getElementById("review-tab")?.focus(); } }} onClick={() => setTab("history")}>Recently merged <span>{history.length.toLocaleString()}</span></button>
        </div><div className={styles.tabActions}>{busy && <span className={styles.syncStatus}>{waiting.length ? `${waiting.length} in undo window` : `${outstanding.length} saving`}</span>}<button type="button" className={styles.refresh} disabled={loading || busy} onClick={() => { setSelected(null); void load(); }}>{loading ? "Refreshing…" : "Refresh"}</button></div></div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {data && !data.mergeEnabled && <p className={styles.error}>Saving merges is unavailable until the reviewed database migration is applied.</p>}
        {tab === "review" ? <section id="review-panel" role="tabpanel" aria-labelledby="review-tab" className={styles.panel}>
          <div className={styles.tableMeta}><span>{candidates.length.toLocaleString()} suggested pairs in loaded results</span><span><kbd>M</kbd> merge after 5s · <kbd>⌘Z</kbd> cancel</span></div>
          <div className={styles.tableScroll} aria-busy={loading}><table className={styles.table} aria-label="Suggested merges"><thead><tr><th scope="col">Profile 1</th><th scope="col">Profile 2</th><th scope="col">Matching evidence</th><th scope="col" className={styles.actionHeading}>Actions</th></tr></thead><tbody>
            {loading ? <tr><td colSpan={4} className={styles.empty} role="status">Loading matching profiles…</td></tr> : !candidates.length ? <tr><td colSpan={4} className={styles.empty}>{filters.length ? "No matches in this view. Try another search or filter." : "Choose a matching rule in the sidebar."}</td></tr> : candidates.map(candidate => {
              const active = selected === candidate;
              const pairKey = JSON.stringify([candidate.left, candidate.right]);
              return <Fragment key={pairKey}>
                <tr ref={node => { if (node) cardsRef.current.set(pairKey, node); else cardsRef.current.delete(pairKey); }} tabIndex={0} aria-selected={active} className={active ? styles.active : undefined} onFocus={() => setSelected(candidate)} onClick={() => setSelected(candidate)}>
                  {[candidate.left, candidate.right].map((id, index) => { const person = people.get(id); return <td key={id}>
                    <div className={styles.profileCell}><input type="radio" name={`primary-${pairKey}`} aria-label={`Use ${person?.name || `profile ${index + 1}`} as main profile ${index + 1}`} title="Use this name and primary email. Both histories are kept." checked={(primaryChoices[pairKey] || candidate.left) === id} onChange={() => { setSelected(candidate); setPrimaryChoices(choices => ({ ...choices, [pairKey]: id })); }} /><div><div className={styles.profileHeading}><strong>{person?.name || "Unnamed guest"}</strong><div className={styles.socialLinks}>{profileSocialLinks(person, candidate).map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${person?.name || "this person"} on ${link.label}`} onClick={event => event.stopPropagation()}>{link.label}<span aria-hidden="true">↗</span></a>)}</div></div><small>{person?.email || "No email"}</small>{person?.phoneNumber && <small>{person.phoneNumber}</small>}</div></div>
                  </td>; })}
                  <td><div className={styles.badges}>{[...new Set(candidate.evidence.map(evidence => evidence.signal))].map(signal => <span key={signal} title={candidate.evidence.filter(evidence => evidence.signal === signal).map(evidence => `${labels[signal]}: ${evidence.value}`).join(" · ")}>{signal === "name" ? "Name" : signal === "social" ? "Social" : "Phone"}</span>)}</div></td>
                  <td><div className={styles.rowActions}><button type="button" className={styles.detailButton} aria-expanded={active && expanded} onClick={event => { event.stopPropagation(); setSelected(candidate); setExpanded(active ? !expanded : true); }}>{active && expanded ? "Close" : "Details"}</button><button type="button" className={styles.mergeButton} disabled={loading || !data?.mergeEnabled || !queueReady} onClick={event => { event.stopPropagation(); merge(candidate); }}>Merge{active && <kbd>M</kbd>}</button></div></td>
                </tr>
                {active && expanded && <tr className={styles.expandedRow}><td colSpan={4}><div className={styles.review} aria-label="Merge preview">
                  <div className={styles.reviewHeader}><h2>Compare profiles</h2><span>The selected main profile supplies the name and primary email. Both histories are kept.</span></div>
                  <table className={styles.compareTable} aria-label="Profile comparison"><thead><tr><th>Field</th>{[candidate.left, candidate.right].map(id => <th key={id}>{people.get(id)?.name || "Unnamed guest"}</th>)}</tr></thead><tbody>{["Phone", "Social profiles", "Tags"].map(field => <tr key={field}><th scope="row">{field}</th>{[candidate.left, candidate.right].map(id => { const person = people.get(id); return <td key={id}>{field === "Phone" ? person?.phoneNumber || "Not provided" : field === "Social profiles" ? socialProfiles(person?.socialLinks) || "Not provided" : Array.isArray(person?.tags) && person.tags.length ? person.tags.map(String).join(" · ") : "No tags"}</td>; })}</tr>)}</tbody></table>
                  <div className={styles.fullEvidence}>{candidate.evidence.map((evidence, index) => <span key={index}>{labels[evidence.signal]}: {evidence.value}</span>)}</div>
                  {previewError ? <p role="alert" className={styles.error}>{previewError}</p> : !detail ? <p role="status">Loading history…</p> : <div className={styles.detailGrid}>
                    <section><h3>{detail.events.length}{detail.registrationsTruncated ? "+" : ""} distinct events · {detail.events.filter(event => event.attended).length} attended</h3><div className={styles.history}>{detail.events.length ? detail.events.map(event => <div key={event.eventId}><strong>{event.title}</strong><small>{event.attended ? "Attended" : "No check-in recorded"} · {event.registrations} registrations</small></div>) : <p>No indexed events.</p>}</div></section>
                    <section><h3>Linked source accounts</h3><div className={styles.history}>{detail.accounts?.length ? detail.accounts.map((account, index) => <div key={index}><strong>{account.account.name}</strong><small>{account.account.email || "No email"}</small></div>) : <p>No additional accounts.</p>}</div></section>
                    {detail.people.some(person => person.comments.length) && <section><h3>Notes</h3><div className={styles.history}>{detail.people.flatMap(person => person.comments.map(comment => <div key={comment.id}><small>{person.name} · {comment.author}</small><p>{comment.body}</p></div>))}</div></section>}
                    {(detail.registrationsTruncated || detail.commentsTruncated) && <p className={styles.partial}>History preview is partial. All original records remain linked when merging.</p>}
                  </div>}
                </div></td></tr>}
              </Fragment>;
            })}
          </tbody></table></div>
        </section> : <section id="history-panel" role="tabpanel" aria-labelledby="history-tab" className={styles.panel}>
          <div className={styles.tableMeta}><span>{visibleHistory.length.toLocaleString()} completed merges</span><span>Successfully saved merges only</span></div>
          <div className={styles.tableScroll}><table className={styles.table} aria-label="Recently merged people"><thead><tr><th scope="col">Combined profiles</th><th scope="col">Main profile</th><th scope="col">Status</th><th scope="col">Confirmed</th></tr></thead><tbody>
            {!visibleHistory.length ? <tr><td colSpan={4} className={styles.empty}>{loading ? "Loading recent merges…" : "No completed merges in this view yet."}</td></tr> : visibleHistory.map(row => <tr key={row.id}>
              <td><div className={styles.historyPeople}>{row.members.map(id => <div key={id}><strong>{people.get(id)?.name || "Previous profile"}</strong><small>{people.get(id)?.email || ""}</small></div>)}</div></td>
              <td><strong>{people.get(row.primary)?.name || "Main profile"}</strong><small>{people.get(row.primary)?.email || ""}</small></td>
              <td><span className={`${styles.status} ${["failed", "uncertain"].includes(row.status) ? styles.statusError : ""}`}>{row.job?.undoRequested && !["undone", "cancelled"].includes(row.status) ? "Undo requested" : statusLabels[row.status]}</span>{row.job?.error && <small className={styles.failure}>{row.job.error}</small>}</td>
              <td><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString(undefined, {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</time></td>

            </tr>)}
          </tbody></table></div>
        </section>}
      </main>
    </div>}
    <div className={styles.toastStack} aria-live="polite">
      {waiting.slice(-3).map(job => <div className={styles.toast} role="status" key={job.id}><span><strong>{people.get(job.primary)?.name || "Merge"}</strong> · {jobMessage(job, clock)}</span><button type="button" onClick={() => undoJob(job.id)}>Undo <kbd>⌘Z</kbd></button></div>)}
      {toastJob && toastJob.status !== "waiting" && <div className={styles.toast} role="status"><span>{jobMessage(toastJob)}</span>{toastJob.status === "uncertain" && <button type="button" onClick={() => retryJob(toastJob.id)}>Retry safely</button>}<button type="button" aria-label="Dismiss notification" onClick={() => setToastJobId(null)}>×</button></div>}
    </div>

  </div>;
}
