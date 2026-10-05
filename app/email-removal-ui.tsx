"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";

export function EmailRemovalControls({request, query, selected, onChanged}) {
  const [status,setStatus] = useState<any>(null), [modal,setModal] = useState(false);
  const [calendars,setCalendars] = useState<any[]>([]), [calendarIds,setCalendarIds] = useState<string[]>([]);
  const [scope,setScope] = useState("selected"), [preview,setPreview] = useState<any>(null);
  const [offset,setOffset] = useState(0), [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  const refs = useRef({request,onChanged}); refs.current={request,onChanged};
  const modalRef = useRef<HTMLDialogElement>(null);
  async function api(url, body?) {
    const res = await refs.current.request(url, body ? {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)} : undefined);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unable to load removals.");
    return data;
  }
  useEffect(() => {
    let live=true;
    let lastProgress="";
    const load=async () => {
      try {
        const data=await api("/api/email-removal");
        if (!live) return;
        setStatus(data);
        const progress=JSON.stringify([data.job?.id,data.job?.succeeded,data.job?.status]);
        if (lastProgress && lastProgress!==progress) { refs.current.onChanged(); window.dispatchEvent(new Event("guestbook:email-removal")); }
        lastProgress=progress;
      } catch(e:any) {if(live) setError(e.message);}
    };
    void load(); const timer=setInterval(() => {if(document.visibilityState==="visible") void load();},10000);
    return () => {live=false;clearInterval(timer);};
  },[]);
  useEffect(() => { if (modal) modalRef.current?.showModal(); },[modal]);
  async function open() {
    setError("");setBusy(true);setPreview(null);setOffset(0);setConfirmed(false);setScope(selected.length?"selected":"all");
    try { const data=await api("/api/email-removal?calendars=1"); setCalendars(data.calendars);setCalendarIds(data.calendars.map(c=>c.id));setModal(true); }
    catch(e:any){setError(e.message);} finally{setBusy(false);}
  }
  async function action(body) {
    setBusy(true);setError("");
    try {
      const data=await api("/api/email-removal",body);
      if(body.action==="preview") {setPreview(data);setOffset(0);setConfirmed(false);}
      else {setModal(false);setStatus(await api("/api/email-removal"));refs.current.onChanged();}
    } catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const job=status?.job;
  return <div className="email-removal-controls">
    <div className="email-removal-bar">
      <button className="button email-removal-button" title="Review blocked email removal from Luma calendars" disabled={!status?.configured || busy || job?.status==="running"} onClick={open}><Trash2 size={15} aria-hidden="true" />{selected.length ? `Remove selected (${selected.length})` : "Remove blocked emails"}</button>
    </div>
    {job || (!status?.configured && status) ? <div className="email-removal-feedback">
      {!status?.configured && status ? <small>Removal is not enabled in this environment.</small>:null}
      {job ? <span role="status">{job.status==="running"?<RefreshCw size={14} className="motion-safe:animate-spin"/>:null} {job.status==="running"?"Removing":job.status==="completed"?"Removal complete":"Removal needs attention"} · {job.succeeded}/{job.total} calendar removals confirmed{job.skipped?` · ${job.skipped} no longer blocked`:""}{job.failed?` · ${job.failed} failed`:""}{job.unknown?` · ${job.unknown} unconfirmed`:""}</span>:null}
      {job && job.status!=="draft" ? <button className="plain" onClick={async()=>{setBusy(true);try{setPreview(await api(`/api/email-removal?job=${job.id}`));setOffset(0);setModal(true);}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>View removal details</button>:null}
    </div>:null}
    {error&&!modal?<p role="alert" className="verification-notice email-removal-error">{error}</p>:null}
    {modal?<dialog ref={modalRef} className="email-removal-dialog" onCancel={e=>{if(busy)e.preventDefault();else setModal(false);}} onClose={()=>setModal(false)}>
      <h3>{preview?preview.job.status==="draft"?"Review removal":"Removal details":"Remove blocked emails"}</h3>
      {!preview?<>
        <p>Choose the calendars to remove these contacts from. After every selected calendar confirms removal, the email becomes inactive in Guestbook.</p>
        <label><input type="radio" name="removal-scope" checked={scope==="selected"} disabled={!selected.length} onChange={()=>setScope("selected")}/> Selected blocked emails ({selected.length})</label>
        <label><input type="radio" name="removal-scope" checked={scope==="all"} onChange={()=>setScope("all")}/> All blocked emails matching {query?`“${query}”`:"the full list"}</label>
        <fieldset><legend>Luma calendars</legend>{calendars.map(c=><label key={c.id}><input type="checkbox" checked={calendarIds.includes(c.id)} onChange={e=>setCalendarIds(ids=>e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))}/>{c.name}</label>)}</fieldset>
        <p>Unconfirmed and unchecked emails are excluded. No contacts are removed until you confirm the preview.</p>
      </>:<>
        <p><strong>{preview.job.emails.toLocaleString()} emails</strong> · {preview.job.total.toLocaleString()} calendar removals · {preview.job.affectedPeople.toLocaleString()} people would have no active email after successful removal.</p>
        <p>Calendars: {preview.job.calendars.map(c=>c.name).join(", ")}. Other calendars are outside this removal.</p>
        <p>This stops calendar invitations and newsletters. Guestbook keeps profiles and event history, but hides people with no active email from search and invitation audiences. Inactive emails remain available in the Inactive filter.</p>
        <div className="cleanup-preview"><table className="guest-table"><thead><tr><th>Email</th><th>Reason</th><th>Calendar / result</th></tr></thead><tbody>{preview.rows.map(r=><tr key={r.emailLower+r.calendarId}><td>{r.name}<small className="tracking-address">{r.emailLower}</small></td><td>{r.reason}</td><td>{preview.job.calendars.find(c=>c.id===r.calendarId)?.name}<small className="tracking-address">{r.status}{r.error?`: ${r.error}`:""}</small></td></tr>)}</tbody></table></div>
        <div className="verification-pagination"><button className="button" disabled={busy||!offset} onClick={async()=>{setBusy(true);try{const next=Math.max(0,offset-50);setPreview(await api(`/api/email-removal?job=${preview.job.id}&offset=${next}`));setOffset(next);}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Previous</button><span>Page {Math.floor(offset/50)+1}</span><button className="button" disabled={busy||!preview.hasMore} onClick={async()=>{setBusy(true);try{setPreview(await api(`/api/email-removal?job=${preview.job.id}&offset=${offset+50}`));setOffset(offset+50);}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>Next</button></div>
        {preview.job.status==="draft"?<label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I confirm removing these emails from the selected calendars and making successfully removed emails inactive.</label>:null}
        {preview.job.unknown?<p>Unconfirmed requests are not retried automatically. Check those contacts in Luma before starting another removal.</p>:null}
      </>}
      {error?<p role="alert">{error}</p>:null}
      <div className="dialog-actions"><button className="button" disabled={busy} onClick={()=>setModal(false)}>Close</button>
        {!preview?<button className="button" disabled={busy||!calendarIds.length} onClick={()=>action({action:"preview",scope,emails:selected,query,calendarIds})}>{busy?"Preparing…":"Preview removal"}</button>:preview.job.status==="draft"?<button className="button danger" disabled={busy||!confirmed} onClick={()=>action({action:"confirm",jobId:preview.job.id,confirmation:"REMOVE_BLOCKED_EMAILS"})}>{busy?"Starting…":"Confirm removal"}</button>:preview.job.failed&&preview.job.status==="needs_attention"?<button className="button" disabled={busy} onClick={()=>action({action:"retry",jobId:preview.job.id})}>Retry failed requests</button>:null}
      </div>
    </dialog>:null}
  </div>;
}
