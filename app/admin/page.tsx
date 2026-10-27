"use client";
import { FormEvent, useEffect, useState } from "react";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import styles from "./page.module.css";
const sans = Instrument_Sans({ subsets: ["latin"] });
const serif = Instrument_Serif({ weight: "400", subsets: ["latin"] });
type Key = { id: string; name: string; prefix: string; scopes: string[]; eventIds: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null };
const permissions = [
  ["events:read", "Read events", "List event details and sync freshness."],
  ["guests:read", "Read guest statuses", "Read names, registration, approval, and attendance."],
  ["guests:email", "Read email addresses", "Include email addresses for your email platform."],
];
export default function Admin() {
  const [adminKey, setAdminKey] = useState("");
  const [draft, setDraft] = useState("");
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopes, setScopes] = useState(["events:read", "guests:read", "guests:email"]);
  async function call(key: string, method = "GET", body?: unknown, id?: string) {
    const response = await fetch(`/api/admin/api-keys${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
      method, headers: { "x-guestbook-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store",
    });
    const result = await response.json() as { error?: string; data?: Key[]; secret?: string };
    if (!response.ok) throw new Error(result.error || "Unable to manage API keys.");
    return result;
  }
  async function load(key: string) {
    const result = await call(key);
    setKeys(result.data); setAdminKey(key);
  }
  useEffect(() => {
    const saved = localStorage.getItem("guestbook.key") || localStorage.getItem("guestbook.session-key");
    if (saved) { setDraft(saved); load(saved).catch(e => setError(e.message)); }
  }, []);
  async function unlock(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await load(draft.trim()); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setSecret("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      const result = await call(adminKey, "POST", {
        name: values.get("name"), scopes,
        eventIds: String(values.get("eventIds") || "").split(/[\s,]+/).filter(Boolean),
        expiresAt: values.get("expiresAt") ? new Date(String(values.get("expiresAt"))).toISOString() : null,
      });
      setSecret(result.secret); form.reset(); await load(adminKey);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!window.confirm("Revoke this key? Software using it will immediately lose access.")) return;
    setBusy(true); setError("");
    try { await call(adminKey, "DELETE", undefined, id); await load(adminKey); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <main className={`${styles.page} ${sans.className}`}>
    <nav><a href="/">Guestbook</a><span>Admin / API access</span></nav>
    <h1 className={serif.className}>Connect your software.</h1>
    <p className={styles.intro}>Create a separate API key for each integration. Choose what it can read and revoke access whenever you need.</p>
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    {keys === null ? <form onSubmit={unlock} className={styles.form}>
      <label>Guestbook admin key<input type="password" value={draft} onChange={e => setDraft(e.target.value)} autoComplete="off" required /></label>
      <p>Use your existing Guestbook login key to manage integrations.</p>
      <button disabled={busy}>Unlock API management</button>
    </form> : <>
      {secret && <section className={styles.notice} aria-label="New API key">
        <h2>Copy your API key</h2><p>This is the only time the full key is shown. Store it in your integration’s secret settings.</p>
        <code>{secret}</code><div className={styles.actions}>
          <button onClick={() => navigator.clipboard.writeText(secret).catch(() => setError("Copy the key manually from above."))}>Copy key</button>
          <button onClick={() => setSecret("")}>Dismiss</button>
        </div>
      </section>}
      <section><h2>Create an API key</h2><form className={styles.form} onSubmit={create}>
        <label>Integration name<input name="name" placeholder="Email platform" maxLength={100} required /></label>
        <fieldset><legend>Permissions</legend>{permissions.map(([scope, label, hint]) => <label className={styles.check} key={scope}>
          <input type="checkbox" checked={scopes.includes(scope)} onChange={e => setScopes(current => e.target.checked ? [...new Set([...current, scope, ...(scope === "guests:email" ? ["guests:read"] : [])])] : current.filter(s => s !== scope && !(scope === "guests:read" && s === "guests:email")))} />
          <span>{label}<small>{hint}</small></span>
        </label>)}</fieldset>
        <label>Restrict to event IDs (optional)<input name="eventIds" placeholder="evt-123, evt-456" /><small>Leave blank for all events. Separate IDs with commas.</small></label>
        <label>Expires at (optional)<input name="expiresAt" type="datetime-local" /></label>
        <button disabled={busy || !scopes.length}>Create API key</button>
      </form></section>
      <section><h2>Integration keys</h2>{keys.length === 0 ? <p>No keys yet.</p> : <div className={styles.keys}>{keys.map(key => <article key={key.id}>
        <div><h3>{key.name}</h3><p><code>{key.prefix}…</code> · {key.revokedAt ? "Revoked" : key.expiresAt && new Date(key.expiresAt) <= new Date() ? "Expired" : "Active"}</p>
          <p>{key.scopes.join(" · ")}</p><p>{key.eventIds.length ? `Events: ${key.eventIds.join(", ")}` : "All events"}</p>
          <small>Created {new Date(key.createdAt).toLocaleDateString()}{key.expiresAt ? ` · Expires ${new Date(key.expiresAt).toLocaleString()}` : " · No expiration"}</small>
        </div>{!key.revokedAt && <button disabled={busy} onClick={() => revoke(key.id)}>Revoke</button>}
      </article>)}</div>}</section>
      <section><h2>Use the API</h2><p>Server API base URL:</p><pre>https://guestbook-production-e5fe.up.railway.app/api/v1</pre><p>Use this service address for server requests to avoid the browser challenge on the custom domain.</p><p>Send your key in the Authorization header. Follow pagination.nextCursor until it is null to retrieve every result.</p>
        <pre>{`GET /api/v1/events\nGET /api/v1/events/{eventId}/guests\nGET /api/v1/events/{eventId}/guests?checked_in=true\nGET /api/v1/events/{eventId}/guests?status=waitlisted\n\nAuthorization: Bearer YOUR_API_KEY`}</pre>
        <p>Every guest request fetches all Luma guest pages before applying filters. Responses include live status, Luma approval status, local operator decision, and registration/check-in timestamps. Email addresses require the email permission.</p>
      </section>
    </>}
  </main>;
}
