"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MergeCandidate, MergeProfile, MergeSignal } from "../api/luma/merge-matching";
import styles from "./page.module.css";

type Operation = { id: string; after: Array<{ personId: string; canonicalId: string }>; createdAt: string; undoneAt: string | null };
type Station = { mergeEnabled: boolean; profiles: MergeProfile[]; candidates: MergeCandidate[]; truncated: boolean; operations: Operation[];
  coverage: { scannedPeople: number; peopleTruncated: boolean; registrationsTruncated: boolean; registrationsPerPerson: number; candidateLimit: number } };
type Preview = { people: Array<MergeProfile & { comments: Array<{ id: string; body: string; author: string }> }>;
  events: Array<{ eventId: string; title: string; attended: boolean; emails: string[]; registrations: number }>;
  registrationsTruncated: boolean; commentsTruncated: boolean };
const labels: Record<MergeSignal, string> = { name: "First + last name", social: "LinkedIn / Twitter", phone: "Phone number" };
export default function MergeStation() {
  const loadRevision = useRef(0);
  const [data, setData] = useState<Station | null>(null);
  const [filters, setFilters] = useState<MergeSignal[]>(["name", "social", "phone"]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MergeCandidate | null>(null);
  const [detail, setDetail] = useState<Preview | null>(null);
  const [primary, setPrimary] = useState("");
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [checked, setChecked] = useState(false);
  const [draft, setDraft] = useState("");
  const request = useCallback(async (suffix = "", init: RequestInit = {}) => {
    const response = await fetch(`/api/people/merge${suffix}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(key ? { "x-guestbook-key": key } : {}), ...init.headers } });
    const body = await response.json() as Station & Preview & { error?: string };
    if (response.status === 401) setAuthorized(false);
    if (!response.ok) throw new Error(body.error || "Unable to complete this request.");
    return body;
  }, [key]);
  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    if (!filters.length) { setLoading(false); return; }
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
    setDetail(null); setPreviewError("");
    if (!selected) return;
    setPrimary(selected.left);
    const controller = new AbortController();
    const query = new URLSearchParams(); query.append("personId", selected.left); query.append("personId", selected.right);
    request(`?${query}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(cause => { if (!controller.signal.aborted) setPreviewError(cause.message); });
    return () => controller.abort();
  }, [selected, request]);
  const people = useMemo(() => new Map(data?.profiles.map(p => [p.personId, p]) || []), [data]);
  const candidates = useMemo(() => data?.candidates.filter(c => c.evidence.some(e => filters.includes(e.signal)))
    .filter(c => !search.trim() || [people.get(c.left), people.get(c.right)].some(p => `${p?.name} ${p?.email}`.toLowerCase().includes(search.trim().toLowerCase()))) || [], [data, filters, people, search]);
  async function merge() {
    if (!selected || !data || !detail) return;
    const previous = data;
    const members = new Set(detail.people.map(p => p.personId));
    setBusy(true); setError("");
    setData({ ...data, candidates: data.candidates.filter(c => !members.has(c.left) && !members.has(c.right)) });
    try {
      await request("", { method: "POST", body: JSON.stringify({ left: selected.left, right: selected.right, primary, reviewedPersonIds: detail.people.map(p => p.personId) }) });
      setSelected(null); setNotice("Profiles merged. Their combined history is available from either profile. Original registrations, notes, and tags are preserved.");
      await load();
    } catch (cause) { setData(previous); setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function undo(operation: Operation) {
    if (!data) return;
    const previous = data;
    setBusy(true); setError("");
    setData({ ...data, operations: data.operations.map(o => o.id === operation.id ? { ...o, undoneAt: new Date().toISOString() } : o) });
    try {
      await request("", { method: "DELETE", body: JSON.stringify({ id: operation.id }) });
      setSelected(null); setNotice("Merge undone. Each profile retains its original records."); await load();
    } catch (cause) { setData(previous); setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <div className={styles.station}>
    <header className={`topbar ${styles.header}`}><a href="/" className={styles.brand}><img src="/guestbook-logo.png" alt="" width="40" height="40" />Guestbook</a><nav className="topbar-actions" aria-label="Guestbook"><a className="button" href="/events">Events</a><a className="button" href="/guests">Guests</a><a className="button primary" href="/merge" aria-current="page">Merge station</a></nav></header>
    <main className={styles.main}>
      <p className="eyebrow">People · Identity review</p><h1>Merge station</h1>
      <p className={styles.intro}>Find the same person across different emails. Review the evidence, then link their profiles into one guest history.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!checked ? <p role="status">Checking access…</p> : !authorized ? <form onSubmit={e => { e.preventDefault(); void unlock(draft); }} className={styles.access}><label>Guestbook key<input type="password" autoComplete="current-password" value={draft} onChange={e => setDraft(e.target.value)} /></label><button className="button primary">Unlock</button></form> : <>
        <section className={styles.toolbar} aria-label="Candidate filters"><div className={styles.filters}>{(Object.keys(labels) as MergeSignal[]).map(signal => <label key={signal}><input type="checkbox" checked={filters.includes(signal)} disabled={busy} onChange={() => { setFilters(old => old.includes(signal) ? old.filter(s => s !== signal) : [...old, signal]); setSelected(null); }} />{labels[signal]}</label>)}</div><label className={styles.search}>Search candidates<input type="search" placeholder="Name or email" value={search} onChange={e => setSearch(e.target.value)} /></label><button className="button" disabled={loading || busy} onClick={() => { setSelected(null); void load(); }}>{loading ? "Scanning…" : "Refresh matches"}</button></section>
        <p className={styles.hint}>Matches use any selected rule. Socials must match exactly, and the profile handle must contain the first name on both records. Phone matching removes formatting and normalizes US +1.</p>
        {data && <p className={styles.coverage}>{candidates.length} suggested pairs · {data.coverage.scannedPeople.toLocaleString()} indexed profiles scanned · up to {data.coverage.registrationsPerPerson} recent registrations per profile</p>}
        {data && (data.truncated || data.coverage.peopleTruncated || data.coverage.registrationsTruncated) && <p role="status" className={styles.warning}>This scan is partial.{data.coverage.peopleTruncated ? " Only the first 10,000 profiles were scanned." : ""}{data.coverage.registrationsTruncated ? " Older registration answers and contact details may not be included." : ""}{data.truncated ? " Showing the first 1,000 candidate pairs." : ""}</p>}
        {data && !data.mergeEnabled && <p className={styles.warning}>Matching and previews are available. Saving merges requires the reviewed database migration; no database setup runs automatically.</p>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        <div className={styles.layout}><section className={styles.candidates} aria-label="Suggested merges" aria-busy={loading}>
          {loading ? <p role="status">Looking for matching profiles…</p> : !data ? null : !candidates.length ? <div className={styles.empty}><h2>{filters.length ? "No matching pairs" : "Select a matching rule"}</h2><p>{filters.length ? "Try another filter or search. Suggestions cover the indexed profiles described above." : "Choose name, social profile, or phone to review suggestions."}</p></div> : candidates.map(c => <button type="button" className={`${styles.candidate} ${selected === c ? styles.active : ""}`} key={JSON.stringify([c.left, c.right])} disabled={busy} onClick={() => setSelected(c)} aria-pressed={selected === c}>
            <span className={styles.pair}>{[c.left, c.right].map(id => <span key={id}><strong>{people.get(id)?.name || "Unnamed guest"}</strong><small>{people.get(id)?.email || "No email"}</small></span>)}</span>
            <span className={styles.badges}>{c.evidence.map((e, i) => <span key={i}>{labels[e.signal]}: {e.value}</span>)}</span>
          </button>)}
        </section><aside className={styles.review} aria-label="Merge preview">
          {!selected ? <div className={styles.empty}><h2>Review a possible match</h2><p>Select a pair to see their profiles, matching evidence, and combined event history.</p></div> : <>
            <h2>Review this merge</h2><p>Choose the primary profile. All original accounts, emails, and registrations remain linked. Undo is available below.</p>
            {previewError ? <p role="alert">{previewError}</p> : !detail ? <p role="status">Loading profiles and history…</p> : <>
              <fieldset disabled={busy}><legend>Primary profile</legend>{detail.people.map(p => <label className={styles.profile} key={p.personId}><input type="radio" name="primary" checked={primary === p.personId} onChange={() => setPrimary(p.personId)} /><span><strong>{p.name}</strong><small>{p.email || "No email"}{p.phoneNumber ? ` · ${p.phoneNumber}` : ""}</small>{Array.isArray(p.tags) && p.tags.length > 0 && <small>Tags: {p.tags.map(String).join(", ")}</small>}</span></label>)}</fieldset>
              <h3>{detail.events.length}{detail.registrationsTruncated ? "+" : ""} distinct events · {detail.events.filter(e => e.attended).length} attended</h3>
              <p className={styles.hint}>Each event counts once, even when both accounts registered.</p>
              {(detail.registrationsTruncated || detail.commentsTruncated) && <p className={styles.warning}>Preview is partial: up to 1,000 registrations and 100 notes per profile. The merge links all records.</p>}
              <div className={styles.history}>{detail.events.map(e => <div key={e.eventId}><strong>{e.title}</strong><small>{e.attended ? "Attended" : "No check-in recorded"} · {e.registrations} registration{e.registrations === 1 ? "" : "s"}</small><small>{e.emails.join(" · ")}</small></div>)}</div>
              {detail.people.some(p => p.comments.length) && <><h3>Notes from both profiles</h3><div className={styles.history}>{detail.people.flatMap(p => p.comments.map(c => <div key={c.id}><small>{p.name} · {c.author}</small><p>{c.body}</p></div>))}</div></>}
              <button className="button primary" disabled={busy || !primary || !data?.mergeEnabled} onClick={() => void merge()}>{busy ? "Saving…" : "Confirm these are the same person"}</button>
            </>}
          </>}
        </aside></div>
        {!!data?.operations.length && <section className={styles.recent}><h2>Recent merges</h2><p>Undo restores the previous identity links. If a group was merged again, undo the newer merge first.</p>{data.operations.map(o => <div key={o.id}><span>{o.after.length} profiles · {new Date(o.createdAt).toLocaleString()} · primary: {people.get(o.after[0]?.canonicalId)?.name || o.after[0]?.canonicalId}</span><button className="button" disabled={busy || !!o.undoneAt} onClick={() => void undo(o)}>{o.undoneAt ? "Undone" : "Undo merge"}</button></div>)}</section>}
      </>}
    </main>
  </div>;
}
