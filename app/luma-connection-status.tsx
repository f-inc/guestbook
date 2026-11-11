"use client";

import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LUMA_SESSION_UPDATED_EVENT, OPEN_LUMA_SETTINGS_EVENT } from "./luma-session";
import {
  connectionCheckFailed, LUMA_NOTIFICATIONS_STORAGE_KEY, readLumaNotifications, reconcileLumaNotifications,
  type ConnectionNotification, type LumaConnection,
} from "./luma-notifications";

export function LumaConnectionStatus({ request }: { request: (input: string, init?: RequestInit) => Promise<Response> }) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const panelRef = useRef<HTMLDetailsElement>(null);
  const [connection, setConnection] = useState<LumaConnection | null>(null);
  const [notifications, setNotifications] = useState<ConnectionNotification[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const checkPending = useRef(false);

  const updateNotifications = (update: (previous: ConnectionNotification[]) => ConnectionNotification[]) => {
    setNotifications((previous) => {
      const next = update(previous);
      try { window.localStorage.setItem(LUMA_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const check = async () => {
    if (inFlight.current) { checkPending.current = true; return; }
    inFlight.current = true;
    setChecking(true);
    try {
      const response = await requestRef.current("/api/luma/connection", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Connection check failed");
      const data = await response.json() as LumaConnection;
      setConnection(data);
      setError(false);
      updateNotifications((previous) => reconcileLumaNotifications(previous, data));
    } catch {
      setError(true);
      updateNotifications((previous) => previous.some((item) => item.id === connectionCheckFailed.id)
        ? previous : [...previous, connectionCheckFailed]);
    } finally {
      inFlight.current = false;
      setChecking(false);
      if (checkPending.current) { checkPending.current = false; void check(); }
    }
  };

  useEffect(() => {
    try { setNotifications(readLumaNotifications(window.localStorage.getItem(LUMA_NOTIFICATIONS_STORAGE_KEY))); } catch {}
    void check();
    const refreshIfVisible = () => { if (document.visibilityState === "visible") void check(); };
    const interval = window.setInterval(refreshIfVisible, 60_000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panelRef.current?.open) {
        panelRef.current.open = false;
        panelRef.current.querySelector("summary")?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) panelRef.current.open = false;
    };
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener(LUMA_SESSION_UPDATED_EVENT, refreshIfVisible);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener(LUMA_SESSION_UPDATED_EVENT, refreshIfVisible);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  return (
    <details className="luma-connection" ref={panelRef}>
      <summary className="button notification-bell" aria-label={`Notifications, ${notifications.length} unresolved`} title="Notifications">
        <Bell size={20} aria-hidden="true" />
        {notifications.length ? <span className="notification-badge" aria-hidden="true">{notifications.length}</span> : null}
      </summary>
      <span className="sr-only" role="status">{notifications.length} unresolved notifications</span>
      <section className="luma-connection-panel" aria-label="Notifications">
        <div className="notification-panel-heading"><strong>Notifications</strong><span>{notifications.length}</span></div>
        {notifications.length ? <ul className="notification-list">
          {notifications.map((notification) => <li key={notification.id} className="notification-item">
            <strong>{notification.title}</strong>
            <p>{notification.message}</p>
            {notification.id !== "luma-check" ? <button className="button" type="button" onClick={() => {
              if (panelRef.current) panelRef.current.open = false;
              window.dispatchEvent(new Event(OPEN_LUMA_SETTINGS_EVENT));
            }}>Update session</button> : null}
            <span className="notification-persistent">Stays here until resolved</span>
          </li>)}
        </ul> : <p>{checking ? "Checking for notifications…" : "You’re all caught up."}</p>}
        <div className="notification-panel-footer">
          {connection ? <p>Last checked {new Date(connection.checkedAt).toLocaleTimeString()}{error ? " · Latest check failed" : ""}</p> : null}
          <button className="button" type="button" onClick={() => void check()} disabled={checking}>{checking ? "Checking…" : "Check again"}</button>
        </div>
      </section>
    </details>
  );
}
