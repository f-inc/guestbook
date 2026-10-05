"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { EmailRemovalControls } from "./email-removal-ui";
import summaryStyles from "./email-verification-summary.module.css";
const labels = { deliverable: "Deliverable", undeliverable: "Undeliverable", risky: "Unconfirmed", unknown: "Unverified", unchecked: "Not checked" };

function verificationLabel(row) {
  if (row.flags?.mailboxFull && row.state !== "undeliverable") return "At risk — mailbox full";
  return labels[row.state];
}

function verificationReason(row) {
  if (row.flags?.mailboxFull) return "Mailbox full — Luma invitations may bounce until space is available";
  if (row.reason === "unavailable_smtp") return "Unable to verify — mail server unavailable during check";
  if (row.reason === "low_deliverability") {
    return row.flags?.acceptAll ? "Accept-all domain; mailbox not confirmed" : "Delivery uncertain — Luma invitations may bounce";
  }
  return row.reason?.replaceAll("_", " ") || "—";
}
export function EmailVerificationSummary({ request, onOpenPerson }) {
  const [selectedRemoval, setSelectedRemoval] = useState<string[]>([]);

  const [notice, setNotice] = useState("");
  const [credits, setCredits] = useState<number | null>(null);
  const [creditError, setCreditError] = useState("");
  const [checkingCredits, setCheckingCredits] = useState(false);
  const [creditRevision, setCreditRevision] = useState(0);
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState("issues");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    let live = true;
    async function loadCredits() {
      setCheckingCredits(true);
      try {
        const response = await requestRef.current("/api/email-verification?credits=1");
        const result = await response.json();
        if (!response.ok || !Number.isSafeInteger(result.available)) throw new Error(result.error || "Unable to check credits.");
        if (live) { setCredits(result.available); setCreditError(""); }
      } catch (e: any) { if (live) { setCredits(null); setCreditError(e.message); } }
      finally { if (live) setCheckingCredits(false); }
    }
    void loadCredits();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadCredits(); }, 30000);
    return () => { live = false; clearInterval(timer); };
  }, [creditRevision]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const response = await requestRef.current(`/api/email-verification?filter=${filter}&q=${encodeURIComponent(query)}&offset=${offset}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (live) { setData(result); setError(""); }
      } catch (e: any) { if (live) setError(e.message); }
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [filter, query, offset, revision]);
  useEffect(() => {
    if (data?.run?.status !== "running") return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      // Bounded work for local/serverless use; DB lease also protects the worker.
      try { await requestRef.current("/api/email-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "advance" }) }); } catch {}
      setRevision((v) => v + 1);
    }, 10000);
    return () => clearInterval(timer);
  }, [data?.run?.status]);
  async function run(action: string) {
    setBusy(true);
    try {
      const response = await requestRef.current("/api/email-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...(action === "start" ? { maxEmails: scanCount } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setRevision((v) => v + 1);
      setCreditRevision((v) => v + 1);
      setError("");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  const s = data?.summary;
  const active = data?.run && ["running", "paused", "submission_unknown"].includes(data.run.status);
  const pending = s ? s.pending : 0;
  const scanCount = Math.min(pending, credits ?? 0);
  function changeFilter(value: string) { setFilter(value); setOffset(0); }
  return (
    <section className="email-verification" aria-label="Email verification">
      <div className="verification-heading">
        <div>
          <h3>Email health</h3>
          <p>Assess bounce risk before sending Luma invitations.</p>
        </div>
        <div className="verification-scan">
          <button className="button primary" disabled={busy || !data?.configured || !!active || !scanCount || checkingCredits} onClick={() => run("start")}>
            <RefreshCw size={16} className={busy || data?.run?.status === "running" ? "motion-safe:animate-spin" : undefined} />{busy ? "Starting…" : active ? "Scan in progress" : `Scan ${scanCount.toLocaleString()} emails`}
          </button>
          <span>{checkingCredits ? "Checking credits…" : credits === null ? "Credits unavailable" : `${credits.toLocaleString()} credits available`}</span>
        </div>
      </div>
      <details className="verification-details">
        <summary>Scan details <ChevronDown size={14} /></summary>
        <div className="verification-details-body">
          <p>Scans send addresses to Emailable and use up to {scanCount.toLocaleString()} credits. Results are reused for 30 days; already blocked addresses are skipped. Recent undeliverable results block new Guestbook invitations.</p>
          {s ? <p>{s.fresh.toLocaleString()} checked in the last 30 days · {pending.toLocaleString()} due for a scan.</p> : null}
          <p>Full mailboxes may bounce Luma invitations until space is available. Unconfirmed and unverified results indicate uncertainty, not a recorded bounce. Verification cannot guarantee delivery.</p>
          {s ? <p>{s.bounced.toLocaleString()} addresses have recorded Luma bounces, which remain even after a deliverable result.</p> : null}
          <button className="button" disabled={checkingCredits} onClick={() => setCreditRevision((v) => v + 1)}><RefreshCw size={14} />{checkingCredits ? "Checking…" : "Refresh credits"}</button>
        </div>
      </details>
      {notice ? <p role="status">{notice}</p> : null}
      {data?.historyTruncated ? <p>Failure evidence is partial. More than 5,000 event records matched this page.</p> : null}
      {creditError ? <p className="verification-notice" role="alert">{creditError} <button className="plain" disabled={checkingCredits} onClick={() => setCreditRevision((v) => v + 1)}>Retry</button></p> : null}
      {data && !data.configured ? <p className="verification-notice" role="status">Email scanning is not connected. Saved results are still available.</p> : null}
      {data?.configured && credits === 0 && pending > 0 ? <p className="verification-notice" role="status">Add credits in Emailable to scan more addresses.</p> : null}
      {error ? <p className="verification-notice" role="alert">{error}</p> : null}
      {data?.run ? <div className="verification-progress" role="status">
        <span>{data.run.status === "completed"
          ? `Last scan complete · ${data.run.processed.toLocaleString()} addresses checked · ${(data.run.skipped || 0).toLocaleString()} skipped`
          : `${(data.run.skipped || 0).toLocaleString()} skipped · ${data.run.status === "running" ? "Scanning" : "Scan paused"} · ${data.run.processed.toLocaleString()} / ${data.run.total.toLocaleString()}`}</span>
        {data.run.status === "running" ? <progress max={Math.max(1, data.run.total)} value={data.run.processed + (data.run.skipped || 0)} aria-label="Verification progress" /> : null}
        {data.run.error ? <p>{data.run.error}</p> : null}
        {data.run.status === "paused" ? <button className="button" disabled={busy || !data.configured} onClick={() => run("resume")}>Resume scan</button> : null}
      </div> : null}
      <section className={summaryStyles.results} aria-label="Results summary" aria-busy={!s}>
        <div className={summaryStyles.heading}>
          <h4>Results summary</h4>
          <p>{s ? `Latest saved results across ${s.total.toLocaleString()} active emails` : "Loading results…"}{data?.run?.status === "running" ? " · Updating as checks finish" : ""}</p>
        </div>
        <dl className={summaryStyles.grid}>
          {Object.entries(labels).map(([state, label]) => (
            <div className={summaryStyles.result} key={state}>
              <dt>{state === "risky" ? "At risk / Unconfirmed" : label}</dt>
              <dd>{s ? Number(s[state]).toLocaleString() : "—"}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="verification-toolbar">
        <div className="verification-filters" role="group" aria-label="Filter email health">
          {[["issues", "Needs review", s ? s.issues : null], ["unchecked", "Not checked", s?.unchecked], ["all", "Active emails", s?.total], ["inactive", "Inactive", s?.inactive]].map(([value, label, count]) => (
            <button key={String(value)} className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => changeFilter(String(value))}>{label}<span>{count == null ? "—" : Number(count).toLocaleString()}</span></button>
          ))}
        </div>
        <label className="verification-search"><Search size={16} /><input type="search" placeholder="Search name or email" aria-label="Search verification results" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} /></label>
        <select aria-label="Verification status" value={filter} onChange={(e) => changeFilter(e.target.value)}>
          <option value="issues">Needs review</option><option value="blocked">Blocked</option><option value="bounced">Recorded Luma bounces</option><option value="all">Active emails</option><option value="inactive">Inactive</option>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{value === "risky" ? "At risk / Unconfirmed" : label}</option>)}
        </select>
      </div>
      <EmailRemovalControls request={request} query={query} selected={selectedRemoval} onChanged={() => { setRevision(v => v + 1); setSelectedRemoval([]); }} />
      <div className="table-wrap"><table className="guest-table">
        <thead><tr><th><input type="checkbox" aria-label="Select blocked emails on this page" checked={!!data?.rows.some(r=>r.decision.status==="blocked") && data.rows.filter(r=>r.decision.status==="blocked").every(r=>selectedRemoval.includes(r.emailLower))} onChange={e=>setSelectedRemoval(e.target.checked ? [...new Set([...selectedRemoval,...data.rows.filter(r=>r.decision.status==="blocked").map(r=>r.emailLower)])] : selectedRemoval.filter(email=>!data.rows.some(r=>r.emailLower===email)))}/></th><th>Guest</th><th>Email Verified?</th><th>Reason</th><th>Sending decision</th></tr></thead>
        <tbody>{data?.rows.map((row) => <tr key={row.emailLower}>
          <td><input type="checkbox" aria-label={`Select ${row.emailLower} for removal`} disabled={row.decision.status!=="blocked"} checked={selectedRemoval.includes(row.emailLower)} onChange={e=>setSelectedRemoval(current=>e.target.checked?[...current,row.emailLower]:current.filter(email=>email!==row.emailLower))}/></td>
          <td><button className="plain verification-person" onClick={() => onOpenPerson?.(row)}>{row.name || row.emailLower}</button><small className="tracking-address">{row.emailLower}</small><small className="tracking-address">Last registration: {row.lastRegisteredAt ? new Date(row.lastRegisteredAt).toLocaleDateString() : "—"}</small></td>
          <td><span className={`status-pill verification-${row.flags?.mailboxFull && row.state !== "undeliverable" ? "risky" : row.state}`}>{verificationLabel(row)}</span><small className="tracking-address">{row.checkedAt ? `from ${new Date(row.checkedAt).toLocaleDateString()}` : "Not checked"}</small></td>
          <td>{verificationReason(row)}</td>
          <td><span className={`status-pill verification-${row.decision.status === "blocked" ? "undeliverable" : row.decision.status === "eligible" ? "deliverable" : "unknown"}`}>{row.decision.label}</span><small className="tracking-address">{row.decision.reason}</small>{row.optOuts?.length ? <small className="tracking-address">Opted out of {row.optOuts.length} calendar{row.optOuts.length === 1 ? "" : "s"}</small> : null}</td>
        </tr>)}</tbody>
      </table></div>
      {data && !data.rows.length ? <p className="empty-state">{s?.unchecked === s?.total ? "Scan emails to check for delivery issues." : "No addresses match this filter."}</p> : null}
      {!data && !error ? <p className="empty-state" role="status">Loading emails…</p> : null}
      {data && (offset > 0 || data.hasMore) ? <div className="verification-pagination"><button className="button" disabled={!offset} onClick={() => setOffset((v) => Math.max(0, v - 50))}>Previous</button><span>Page {Math.floor(offset / 50) + 1}</span><button className="button" disabled={!data?.hasMore} onClick={() => setOffset((v) => v + 50)}>Next</button></div> : null}

    </section>
  );
}

export function AudienceVerification({ request, criteria, eventIds }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const key = JSON.stringify([criteria, eventIds]);
  const current = useRef({ request, criteria, eventIds }); current.current = { request, criteria, eventIds };
  async function load() {
    const { request, criteria, eventIds } = current.current;
    const response = await request("/api/email-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", criteria, eventIds }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  useEffect(() => {
    let live = true; setData(null);
    const refresh = () => load().then(d => { if(live) { setData(d); setError(""); } }).catch(e => { if(live) setError(e.message); });
    void refresh(); const timer = setInterval(refresh, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [key]);
  const count = Math.min(data?.pending || 0, data?.credits || 0);
  return <div className="verification-details-body"><h4>Check this audience before sending</h4><p>{data ? `${data.total - data.eligible} blocked for all selected events · ${data.fresh} fresh results reused · ${data.pending} due for verification · ${data.credits} credits available` : "Checking audience…"}</p><p>Blocked addresses are skipped at send time. Unconfirmed and unchecked addresses are allowed.</p>{error ? <p role="alert">{error}</p> : null}<button className="button" disabled={busy || !count} onClick={async () => {
    setBusy(true);
    try {
      const { request, criteria, eventIds } = current.current;
      const response = await request("/api/email-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", criteria, eventIds, maxEmails: count }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      setError("Verification queued. Results update here as checks finish; full progress is in Guests → Email health.");
    } catch(e: any) { setError(e.message); } finally { setBusy(false); }
  }}>{busy ? "Starting…" : `Verify up to ${count} selected emails`}</button></div>;
}
