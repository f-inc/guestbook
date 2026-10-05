"use client";
import { EmailVerificationSummary } from "./email-verification-ui";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { RefreshCw, ArrowLeft, AlertCircle } from "lucide-react";
import { inviteStatusLabels } from "./invite-tracking";
const TrackingContext = createContext<any>(null);
const TOKEN_KEY = "guestbook.lumaAuthSession";
export function InvitationTrackingProvider({
  children,
  targets = [],
  eventIds,
  active,
  request,
  revision,
}: {
  children: any;
  targets?: { personId: string; eventId: string }[];
  eventIds: string[];
  active: boolean;
  request: any;
  revision?: number;
}) {
  const [data, setData] = useState<any>({
    rows: [],
    counts: [],
    tracked: 0,
    total: 0,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const [token, setToken] = useState("");
  const lock = useRef(false);
  const key = eventIds.join(",");
  const targetKey = JSON.stringify(targets.slice(0, 50));
  const currentKey = useRef(key);
  currentKey.current = key;
  const loadedKey = useRef(key);
  useEffect(() => {
    const resume = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== TOKEN_KEY) return;
      setDisconnected(false);
      setError("");
    };
    window.addEventListener("storage", resume);
    window.addEventListener("guestbook:luma-session-updated", resume);
    return () => {
      window.removeEventListener("storage", resume);
      window.removeEventListener("guestbook:luma-session-updated", resume);
    };
  }, []);

  async function load() {
    if (!key) return;
    const params = new URLSearchParams();
    eventIds.forEach((id) => params.append("event", id));
    const r = await request(`/api/invitation-tracking?${params}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Unable to load tracking.");
    const visibleParams = new URLSearchParams(params);
    JSON.parse(targetKey).forEach((t) =>
      visibleParams.append("person", t.personId),
    );
    if (d.hasMore && targets.length) {
      const visibleResponse = await request(
        `/api/invitation-tracking?${visibleParams}`,
      );
      if (visibleResponse.ok) {
        const visible = await visibleResponse.json();
        d.rows = [
          ...new Map(
            [...d.rows, ...visible.rows].map((row: any) => [
              row.eventId + ":" + row.emailLower,
              row,
            ]),
          ).values(),
        ];
      }
    }
    if (currentKey.current === key) setData(d);
  }
  async function refresh(
    manual = false,
    sessionToken?: string,
    detailTargets?: { eventId: string; emailLower: string }[],
  ) {
    if (lock.current || !eventIds.length) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await request("/api/invitation-tracking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "refresh",
          eventIds,
          manual,
          targets: detailTargets || JSON.parse(targetKey),
          details: !!detailTargets,
          reconnect: !!sessionToken,
          lumaSessionToken:
            sessionToken ||
            window.localStorage.getItem(TOKEN_KEY) ||
            window.sessionStorage.getItem(TOKEN_KEY) ||
            "",
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.code === "LUMA_SESSION_INVALID") setDisconnected(true);
        throw new Error(d.error || "Unable to refresh tracking.");
      }
      setDisconnected(false);
      setError("");
      await load();
    } catch (e: any) {
      setError(e.message);
      await load().catch(() => {});
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (loadedKey.current !== key) {
      setData({ rows: [], counts: [], tracked: 0, total: 0 });
      loadedKey.current = key;
    }
    void load().catch((e) => setError(e.message));
  }, [key, revision, targetKey]);
  useEffect(() => {
    if (!active || !key || disconnected) return;
    const run = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    run();
    const timer = window.setInterval(run, 60000);
    return () => window.clearInterval(timer);
  }, [active, key, disconnected, revision, targetKey]);
  useEffect(() => {
    if ((!busy && !data.bulkRefreshActive) || !active) return;
    const timer = window.setInterval(() => {
      void load().catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [busy, active, key, targetKey, data.bulkRefreshActive]);
  return (
    <TrackingContext.Provider
      value={{
        ...data,
        error,
        busy,
        refresh,
        disconnected,
        reconnect: () => setReconnect(true),
      }}
    >
      {children}
      {reconnect ? (
        <div className="modal-scrim">
          <form
            className="dialog event-dialog"
            onSubmit={async (e) => {
              e.preventDefault();
              const value = token.trim();
              window.localStorage.setItem(TOKEN_KEY, value);
              window.sessionStorage.removeItem(TOKEN_KEY);
              setToken("");
              setReconnect(false);
              await refresh(true, value);
            }}
          >
            <p className="eyebrow">Luma connection</p>
            <h2>Reconnect email tracking</h2>
            <p>
              Enter your Luma session token. It is saved in this browser. After
              a successful tracking check, an encrypted copy is saved on our
              server for background refresh.
            </p>
            <label>
              Session token
              <input
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setReconnect(false);
                  setToken("");
                }}
              >
                Cancel
              </button>
              <button className="button primary">Connect & refresh</button>
            </div>
          </form>
        </div>
      ) : null}
    </TrackingContext.Provider>
  );
}
export function InvitationStatus({
  status,
  eventId,
  personId,
  email,
}: {
  status: string;
  eventId: string;
  personId?: string;
  email?: string;
}) {
  const tracking = useContext(TrackingContext);
  if (status !== "invited") return null;
  const row = tracking?.rows.find(
    (r) =>
      r.eventId === eventId &&
      ((!!personId && r.personId === personId) ||
        (!!email && r.emailLower === email.toLowerCase())),
  );
  const value = row?.status || "unknown";
  return (
    <span
      className={`status-pill invite-status-${value}`}
      title={
        value === "reported"
          ? "Reported as spam"
          : row?.bulkCheckedAt || row?.checkedAt
            ? `Last refreshed ${new Date(row.bulkCheckedAt || row.checkedAt).toLocaleString()}`
            : "Email tracking has not been checked."
      }
    >
      {!row?.checkedAt && !row?.bulkCheckedAt && value === "unknown"
        ? "Invited · Tracking not loaded"
        : inviteStatusLabels[value] || inviteStatusLabels.unknown}
    </span>
  );
}
export function TrackingControls({ compact = false }: { compact?: boolean } = {}) {
  const t = useContext(TrackingContext);
  if (!t) return null;
  return (
    <div className="tracking-controls">
      <span>
        {compact
          ? t.bulkRefreshActive ? "Updating invitations…" : `${(t.checked || 0).toLocaleString()} invitations loaded`
          : `${t.checked || 0} of ${Math.max(t.total || 0, t.tracked || 0)} invitations loaded · ${t.queued || 0} email detail checks queued${t.bulkRefreshActive ? " · Loading invitations…" : ""}`}
      </span>
      <button
        className="button"
        disabled={t.busy}
        onClick={() => t.refresh(true)}
      >
        <RefreshCw size={14} />
        {t.busy ? "Checking…" : "Refresh invitations"}
      </button>
      {t.refreshWarning && !t.error ? (
        <p role="status">{t.refreshWarning}</p>
      ) : null}
      {t.error ? (
        <div className="tracking-error" role="status">
          <AlertCircle size={15} />
          {t.error}
          {t.disconnected ? (
            <button className="button" onClick={t.reconnect}>
              Reconnect Luma
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
export function InvitationOutcomes({ stages, onFilter, cohort = "all" }) {
  const t = useContext(TrackingContext);
  if (!t) return null;
  const count = (status: string) => t.counts.find((item) => item.status === status)?.count || 0;
  const totalStage = stages.find((stage) => stage.id === "total");
  const total = cohort === "all" ? Math.max(t.total || 0, t.tracked || 0, totalStage?.value || 0) : totalStage?.value || 0;
  const declinedStage = stages.find((stage) => stage.id === "declined");
  const funnel = [
    { id: "total", label: "Invitations", value: total, action: () => onFilter(totalStage?.filter || "invited") },
    ...(cohort === "all" ? [
      { id: "opened", label: "Opened", value: count("opened") + count("clicked"), action: () => onFilter("invited_opened") },
      { id: "clicked", label: "Clicked", value: count("clicked"), action: () => onFilter("invited_clicked") },
    ] : []),
    ...stages.filter((stage) => stage.id === "accepted").map((stage) => ({ ...stage, action: () => onFilter(stage.filter) })),
  ];
  return (
    <section className="invitation-delivery invitation-funnel-summary">
      <ol className="funnel-chart invitation-funnel-chart">
        {funnel.map((stage) => {
          const rate = total ? Math.round(stage.value / total * 100) : 0;
          return <li className={`invitation-stage-${stage.id}`} key={stage.id}>
            <div className="invitation-funnel-row-heading">
              <button type="button" className="analytics-funnel-filter invitation-stage-primary" onClick={stage.action} aria-label={`View ${stage.value.toLocaleString()} ${stage.label.toLowerCase()}`}>
                <strong>{stage.value.toLocaleString()}</strong><small>{stage.label}</small>
              </button>
              {stage.id === "opened" ? <button type="button" className="analytics-funnel-filter invitation-inline-outcome invitation-inline-bounced" onClick={() => onFilter("invited_bounced")} aria-label={`View ${count("bounced").toLocaleString()} bounced invitations`}><strong>{count("bounced").toLocaleString()}</strong>{" "}<span>Bounced</span></button> : null}
              {stage.id === "accepted" && declinedStage ? <button type="button" className="analytics-funnel-filter invitation-inline-outcome" onClick={() => onFilter(declinedStage.filter)} aria-label={`View ${declinedStage.value.toLocaleString()} declined invitations`}><strong>{declinedStage.value.toLocaleString()}</strong>{" "}<span>Declined</span></button> : null}
            </div>
            <button type="button" className="analytics-funnel-filter invitation-stage-bar-row" onClick={stage.action} aria-label={`View ${stage.label.toLowerCase()}: ${rate}% of invitations`}>
              <span className="invitation-stage-track" aria-hidden="true"><i style={{ width: `${Math.min(100, rate)}%` }} /></span><em>{rate}%</em>
            </button>
          </li>;
        })}
      </ol>
      {cohort === "all" && count("reported") > 0 ? <div className="invitation-secondary-outcomes"><button className="invitation-issue-count" onClick={() => onFilter("invited_reported")}><strong>{count("reported").toLocaleString()}</strong> Reported</button></div> : null}
      <TrackingControls compact />
    </section>
  );
}
function MessageHistory({ row }: any) {
  const t = useContext(TrackingContext);
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return (
    <details className="message-history">
      <summary>
        <span className={`status-pill invite-status-${row.status}`}>
          {inviteStatusLabels[
            row.status === "unknown" && !row.checkedAt && !row.bulkCheckedAt
              ? "not_loaded"
              : row.status
          ] || "Unknown"}
        </span>
      </summary>
      {row.bulkInvite?.id ? (
        <div className="email-history-entry">
          <small>
            Invitation created:{" "}
            {new Date(row.bulkInvite.createdAt).toLocaleString()}
          </small>
          {row.bulkInvite.openedAt ? (
            <small>
              Open recorded:{" "}
              {new Date(row.bulkInvite.openedAt).toLocaleString()}
            </small>
          ) : (
            <small>No open recorded by Luma.</small>
          )}
        </div>
      ) : null}
      {t ? (
        <button
          className="button"
          disabled={t.busy}
          onClick={() =>
            t.refresh(true, undefined, [
              { eventId: row.eventId, emailLower: row.emailLower },
            ])
          }
        >
          Check email details
        </button>
      ) : null}
      {row.lastError ? (
        <p role="status">
          Email details could not be refreshed. Cached observations are shown;
          try again.
        </p>
      ) : null}
      {messages.length ? (
        messages.map((m) => (
          <div className="email-history-entry" key={m.id}>
            <strong>{inviteStatusLabels[m.status]}</strong>
            {[
              "sentAt",
              "deliveredAt",
              "openedAt",
              "clickedAt",
              "bouncedAt",
              "reportedAt",
            ]
              .filter((k) => m[k])
              .map((k) => (
                <small key={k}>
                  {k.replace("At", "")}: {new Date(m[k]).toLocaleString()}
                </small>
              ))}
          </div>
        ))
      ) : (
        <p>
          Delivery, click, bounce and spam details{" "}
          {row.checkedAt
            ? "were not returned for this invitation."
            : "have not been checked."}
        </p>
      )}
    </details>
  );
}
export function GuestsPageFrame({
  children,
  request,
  onBack,
  onOpenPerson,
}: {
  children: any;
  request: any;
  onBack: () => void;
  onOpenPerson: (row: any) => void;
}) {
  const [tab, setTab] = useState("all");
  useEffect(() => {
    const restore = () =>
      setTab(
        new URLSearchParams(window.location.search).get("guests_tab") ===
          "issues"
          ? "issues"
          : "all",
      );
    const focus = () => {
      changeTab("all");
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>(
              '.guests-directory input[type="search"]',
            )
            ?.focus(),
        ),
      );
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("guestbook:focus-guests-search", focus);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("guestbook:focus-guests-search", focus);
    };
  }, []);
  function changeTab(value: string) {
    setTab(value);
    const u = new URL(window.location.href);
    if (value === "issues") u.searchParams.set("guests_tab", "issues");
    else u.searchParams.delete("guests_tab");
    window.history.replaceState(window.history.state, "", u);
  }
  return (
    <main className="guests-page">
      <div className="guests-page-heading">
        <div>
          <p className="eyebrow">Your community</p>
          <h2>Guests</h2>
          <p>Find people, revisit their history, and manage email issues.</p>
        </div>
        <button className="button" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to events
        </button>
      </div>
      <nav className="event-tabs" aria-label="Guests sections">
        <button
          className={`event-tab ${tab === "all" ? "active" : ""}`}
          onClick={() => changeTab("all")}
        >
          All guests
        </button>
        <button
          className={`event-tab ${tab === "issues" ? "active" : ""}`}
          onClick={() => changeTab("issues")}
        >
          Email health
        </button>
      </nav>
      {tab === "all" ? (
        children
      ) : (
        <EmailIssues request={request} onOpenPerson={onOpenPerson} />
      )}
    </main>
  );
}
function EmailIssues({ request, onOpenPerson }) {
  return <EmailVerificationSummary request={request} onOpenPerson={onOpenPerson} />;
}
