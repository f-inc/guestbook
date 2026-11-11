"use client";

import { useEffect, useState } from "react";
import { LUMA_SESSION_HEADER, LUMA_SESSION_STORAGE_KEY, LUMA_SESSION_UPDATED_EVENT, normalizeBrowserLumaSession } from "./luma-session";
import type { LumaConnection } from "./luma-notifications";

export function LumaSessionSettings({ request, onConnected }: {
  request: (input: string, init?: RequestInit) => Promise<Response>;
  onConnected: () => void;
}) {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    try { setSaved(Boolean(window.localStorage.getItem(LUMA_SESSION_STORAGE_KEY))); } catch {}
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const value = normalizeBrowserLumaSession(token);
    setError("");
    setMessage("");
    if (!value) { setError("Paste the complete Luma session cookie value."); return; }
    setSaving(true);
    try {
      const response = await request("/api/luma/connection", {
        headers: { [LUMA_SESSION_HEADER]: value }, cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Unable to check your session. Try again.");
      const result = await response.json() as LumaConnection;
      const session = result.sessions.find((item) => item.name === "browser-session");
      if (session?.status === "invalid") throw new Error("Luma rejected this session. Copy a fresh cookie from your signed-in Luma browser.");
      if (session?.status !== "connected") throw new Error("Couldn’t verify your session. Your previous saved session has been kept. Try again.");
      try { window.localStorage.setItem(LUMA_SESSION_STORAGE_KEY, value); }
      catch { throw new Error("Your browser couldn’t save the session. Allow site storage and try again."); }
      setSaved(true);
      setToken("");
      window.dispatchEvent(new Event(LUMA_SESSION_UPDATED_EVENT));
      onConnected();
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== "TimeoutError" && failure.name !== "AbortError"
        ? failure.message : "The connection check timed out. Try again.");
    } finally { setSaving(false); }
  };

  const remove = () => {
    try { window.localStorage.removeItem(LUMA_SESSION_STORAGE_KEY); }
    catch { setError("Your browser couldn’t remove the saved session. Try again."); return; }
    setSaved(false);
    setToken("");
    setError("");
    setMessage("Saved session removed. Server connections will be used when available.");
    window.dispatchEvent(new Event(LUMA_SESSION_UPDATED_EVENT));
  };

  return <form className="luma-session-settings" onSubmit={save}>
    <p className="luma-session-storage-state">{saved ? "Session saved in this browser" : "No session saved in this browser"}</p>
    <label className="luma-session-field">
      <span>{saved ? "Replace session token" : "Session token"}</span>
      <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste your Luma session cookie" disabled={saving} />
    </label>
    <p className="luma-session-settings-note">Saved only in this browser for event discovery and Luma actions. It grants access to your Luma account. It is sent securely to Guestbook when needed and is never saved to the database or displayed again.</p>
    <details className="luma-session-instructions">
      <summary>Where do I find my session token?</summary>
      <ol>
        <li>Sign in at <a href="https://luma.com" target="_blank" rel="noreferrer">luma.com</a>.</li>
        <li>Open Developer Tools (⌘⌥I on Mac), then Application → Storage → Cookies → https://luma.com.</li>
        <li>Copy the complete Value of <code>luma.auth-session-key</code>.</li>
        <li>Paste it above and select Save and connect.</li>
      </ol>
    </details>
    {error ? <p className="session-error" role="alert">{error}</p> : null}
    {message ? <p className="luma-session-success" role="status">{message}</p> : null}
    <div className="luma-session-settings-actions">
      {saved ? <button className="button" type="button" disabled={saving} onClick={remove}>Remove saved session</button> : null}
      <button className="button primary" type="submit" disabled={saving || !token.trim()}>{saving ? "Checking session…" : "Save and connect"}</button>
    </div>
  </form>;
}
