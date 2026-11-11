"use client";

import { ArrowLeft, ArrowUpRight, ChevronRight, FileText, KeyRound, Link2, Settings, Tag, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LumaSessionSettings } from "./luma-session-settings";
import { OPEN_LUMA_SETTINGS_EVENT } from "./luma-session";

export function WorkspaceSettings({ onOpenTags, request }: { onOpenTags: () => void; request: (input: string, init?: RequestInit) => Promise<Response> }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"home" | "luma">("home");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const openLuma = () => { setSection("luma"); setOpen(true); };
    window.addEventListener(OPEN_LUMA_SETTINGS_EVENT, openLuma);
    return () => window.removeEventListener(OPEN_LUMA_SETTINGS_EVENT, openLuma);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const close = () => {
    dialogRef.current?.close();
    setOpen(false);
  };

  return <>
    <button className="button workspace-settings-trigger" type="button" aria-label="Settings" title="Settings" aria-haspopup="dialog" onClick={() => { setSection("home"); setOpen(true); }}>
      <Settings size={20} aria-hidden="true" />
    </button>
    <dialog
      ref={dialogRef}
      className="workspace-settings-modal"
      aria-labelledby="workspace-settings-title"
      aria-describedby="workspace-settings-description"
      onClose={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
    >
      <div className="workspace-settings-heading">
        {section === "home" ? <div className="workspace-settings-emblem"><Settings size={24} aria-hidden="true" /></div>
          : <button className="button" type="button" onClick={() => setSection("home")}><ArrowLeft size={16} aria-hidden="true" /> Settings</button>}
        <button className="icon-button" type="button" aria-label="Close settings" onClick={close}><X size={20} aria-hidden="true" /></button>
      </div>
      <h2 id="workspace-settings-title">{section === "home" ? "Settings" : "Luma connection"}</h2>
      <p id="workspace-settings-description">{section === "home" ? "Manage your Guestbook workspace." : "Connect or update your personal Luma session."}</p>
      {section === "home" ? <>
      <p className="workspace-settings-section-label">Workspace</p>
      <nav className="workspace-settings-options" aria-label="Workspace settings">
        <button className="workspace-settings-option" type="button" onClick={() => setSection("luma")}>
          <span className="workspace-settings-option-icon"><Link2 size={21} aria-hidden="true" /></span>
          <span className="workspace-settings-option-copy"><strong>Luma connection</strong><span>Connect or update your saved session.</span></span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <a className="workspace-settings-option" href="/admin">
          <span className="workspace-settings-option-icon"><KeyRound size={21} aria-hidden="true" /></span>
          <span className="workspace-settings-option-copy"><strong>API access</strong><span>Manage API keys and integration access.</span></span>
          <ArrowUpRight size={18} aria-hidden="true" />
        </a>
        <a className="workspace-settings-option" href="/requests">
          <span className="workspace-settings-option-icon"><FileText size={21} aria-hidden="true" /></span>
          <span className="workspace-settings-option-copy"><strong>Requests</strong><span>Review incoming requests and submissions.</span></span>
          <ArrowUpRight size={18} aria-hidden="true" />
        </a>
        <button className="workspace-settings-option" type="button" onClick={() => { close(); onOpenTags(); }}>
          <span className="workspace-settings-option-icon"><Tag size={21} aria-hidden="true" /></span>
          <span className="workspace-settings-option-copy"><strong>Tags</strong><span>Manage tags, automatic rules, and supertags.</span></span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </nav>
      </> : open ? <LumaSessionSettings request={request} onConnected={close} /> : null}
    </dialog>
  </>;
}
