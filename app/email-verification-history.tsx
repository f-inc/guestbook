"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import styles from "./email-verification-summary.module.css";

const statuses: Record<string, string> = {
  running: "Running", paused: "Paused", submission_unknown: "Needs reconciliation",
  completed: "Completed", submitting: "Submitting", waiting: "Waiting for results", rejected: "Rejected",
};
const date = (value: string) => value ? new Date(value).toLocaleString() : "—";

function useHistory(request, runId?: string) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const ref = useRef(request); ref.current = request;
  useEffect(() => {
    let live = true;
    async function load() {
      setLoading(true);
      try {
        const response = await ref.current(`/api/email-verification?history=1&offset=${offset}${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to load scan history.");
        if (live) { setData(result); setError(""); }
      } catch (e: any) { if (live) setError(e.message); }
      finally { if (live) setLoading(false); }
    }
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [offset, revision, runId]);
  return { data, error, loading, offset, setOffset, refresh: () => setRevision(v => v + 1) };
}
function Paging({ history }) {
  return history.data && (history.offset > 0 || history.data.hasMore) ? <div className={styles.historyActions}>
    <button className="button" disabled={!history.offset || history.loading} onClick={() => history.setOffset(v => Math.max(0, v - 20))}>Previous</button>
    <span>Page {history.offset / 20 + 1}</span>
    <button className="button" disabled={!history.data.hasMore || history.loading} onClick={() => history.setOffset(v => v + 20)}>Next</button>
  </div> : null;
}
function Batches({ request, runId }) {
  const history = useHistory(request, runId);
  return <div className={styles.batchDetails}>
    <p>Scan ID: <code>{runId}</code></p>
    {history.error ? <p role="alert">{history.error} <button className="button" onClick={history.refresh}>Retry</button></p> : null}
    {!history.data ? <p role="status">Loading batches…</p> : history.data.batches.length ? <div className="table-wrap"><table className={styles.historyTable}>
      <caption>Submitted batches, newest first</caption>
      <thead><tr><th scope="col">Submitted</th><th scope="col">Status</th><th scope="col">Addresses</th><th scope="col">Emailable batch ID</th></tr></thead>
      <tbody>{history.data.batches.map(batch => <tr key={batch.id}><td>{date(batch.createdAt)}</td><td>{statuses[batch.status] || batch.status}</td><td>{batch.total.toLocaleString()}</td><td><code>{batch.providerId || "Not accepted by provider"}</code></td></tr>)}</tbody>
    </table></div> : <p>No batches submitted yet.</p>}
    <Paging history={history} />
  </div>;
}
function HistoryTable({ request }) {
  const history = useHistory(request);
  const [expanded, setExpanded] = useState<string | null>(null);
  return <div className={styles.historyBody}>
    <div className={styles.historyActions}><p>Saved scans, newest first. Combined requests share one scan. Updates every 15 seconds.</p><button className="button" disabled={history.loading} onClick={history.refresh}><RefreshCw size={14} />Refresh history</button></div>
    {history.error ? <p role="alert">{history.error}</p> : null}
    {!history.data ? <p role="status">Loading scan history…</p> : !history.data.runs.length ? <p>No email scans have been run yet.</p> : <div className="table-wrap"><table className={styles.historyTable}>
      <caption className={styles.srOnly}>Email verification scan history</caption>
      <thead><tr><th scope="col">Started</th><th scope="col">Status</th><th scope="col">Progress</th><th scope="col">Audience</th><th scope="col">Finished</th><th scope="col">Details</th></tr></thead>
      <tbody>{history.data.runs.map(run => <Fragment key={run.id}>
        <tr><td>{date(run.startedAt)}</td><td><span className={styles.historyStatus}>{statuses[run.status] || run.status}</span></td><td>{run.processed.toLocaleString()} / {run.total.toLocaleString()} checked<small>{run.skipped.toLocaleString()} skipped</small></td><td>{run.eventIds?.length ? `${run.eventIds.length} selected event${run.eventIds.length === 1 ? "" : "s"}` : "Community"}</td><td>{date(run.completedAt)}</td><td><button className="button" aria-expanded={expanded === run.id} aria-controls={`scan-${run.id}`} onClick={() => setExpanded(v => v === run.id ? null : run.id)}>{expanded === run.id ? "Hide" : "View"} batches</button></td></tr>
        {expanded === run.id ? <tr><td colSpan={6} id={`scan-${run.id}`}>
          {run.error ? <p role="status">{run.error}</p> : null}
          {run.status === "running" ? <p>Next worker check eligible after {date(run.nextCheckAt)}. Keep Email health open or run the tracking worker to advance the scan.</p> : null}
          <Batches request={request} runId={run.id} />
        </td></tr> : null}
      </Fragment>)}</tbody>
    </table></div>}
    <Paging history={history} />
  </div>;
}
export function EmailVerificationHistory({ request }) {
  const [open, setOpen] = useState(false);
  return <details className={styles.history} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Scan history <ChevronDown size={16} /></summary>
    {open ? <HistoryTable request={request} /> : null}
  </details>;
}
