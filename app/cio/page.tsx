"use client";

import { useState } from "react";
import Link from "next/link";
import { CIO_ANSWER_MAPPINGS, CIO_TAG_MAPPINGS } from "../api/luma/cio-mapping";

const tabs = ["Mapping", "Exclusions", "Preview", "Health"] as const;
type Tab = typeof tabs[number];
const card = "rounded-2xl border border-border bg-surface p-6";
const table = "w-full text-left text-sm [&_th]:p-3 [&_td]:p-3 [&_td]:align-top [&_tr]:border-b [&_tr]:border-border";

export default function CioReviewPage() {
  const [tab, setTab] = useState<Tab>("Mapping");
  const [email, setEmail] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function inspect(action: "preview" | "health") {
    setBusy(true); setError("");
    if (action === "preview") setPreview(null);
    else setHealth(null);
    try {
      const response = await fetch("/api/cio/sync", action === "preview" ? {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, email }),
      } : { credentials: "same-origin", cache: "no-store" });
      const result: any = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? "Open Guestbook and sign in, then return here." : result.error || "Unable to load. Check the sync configuration and migration.");
      if (action === "preview") setPreview(result); else setHealth(result);
    } catch (e: any) { setError(e.message || "Unable to load."); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm font-semibold text-brand">GUESTBOOK / CUSTOMER.IO</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sync review</h1>
        <p className="mt-2 max-w-2xl text-muted">Review source mappings, invitation exclusions and the exact profile update before delivery.</p></div>
      <Link href="/" className="rounded-lg border border-border bg-surface px-4 py-2 text-sm">Back to Guestbook</Link>
    </header>
    <div className="rounded-xl bg-brand-soft px-5 py-4 text-sm text-brand">Review only. These tabs do not import people, change tags or send messages. Delivery is controlled separately.</div>
    <nav aria-label="Sync review sections" className="flex flex-wrap gap-2">{tabs.map(t => <button key={t} aria-current={tab === t ? "page" : undefined} onClick={() => { setTab(t); setError(""); }} className={`rounded-lg px-5 py-3 text-sm font-medium ${tab === t ? "bg-brand text-white" : "border border-border bg-surface"}`}>{t}</button>)}</nav>
    {error && <p role="alert" className="rounded-xl bg-danger-soft p-4 text-danger">{error}</p>}
    {tab === "Mapping" && <>
      <section className={card}><h2 className="text-xl font-semibold">Existing profile fields stay authoritative</h2>
        <p className="mt-3 text-muted">Names, company, location, roles, applications, unsubscribe settings and topic preferences already in Customer.io are preserved. Guestbook writes only <code>finc_luma_</code> fields. A source tag never grants marketing consent or proves portfolio membership.</p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm"><li>Match only an explicitly listed question label. Unmapped questions stay in Guestbook.</li><li>Use the answer’s source timestamp; fall back to the original Luma registration timestamp when available. Never use import time, event date or general guest update time.</li><li>Keep the newest valid nonblank answer and its event, question and timestamp. Retain the last delivered answer when older records are replayed.</li><li>Flag equal-time disagreements, unknown dates and unsupported values for review. Do not guess a winner.</li></ol>
      </section>
      <section className={card}><h2 className="mb-4 text-xl font-semibold">Answer mappings</h2><div className="overflow-x-auto"><table className={table}><thead><tr><th>Exact source question</th><th>Customer.io attribute</th></tr></thead><tbody>{CIO_ANSWER_MAPPINGS.map(m => <tr key={m.key}><td>{m.labels.join(" · ")}</td><td><code>finc_luma_profile_{m.key}</code></td></tr>)}</tbody></table></div><p className="mt-3 text-sm text-muted">Mappings are reviewed in code. Labels ignore case and trailing punctuation. Structured objects, multiple selections and unknown questions need an explicit mapping before export.</p></section>
      <section className={card}><h2 className="mb-4 text-xl font-semibold">Guestbook tags</h2><div className="overflow-x-auto"><table className={table}><thead><tr><th>Source tag</th><th>Value in finc_luma_guestbook_tags</th><th>Behavior</th></tr></thead><tbody>{CIO_TAG_MAPPINGS.map(m => <tr key={m.key}><td>{m.label}</td><td><code>{m.key}</code></td><td>{m.exclusion ? "Exclude from invitations; never create a new profile" : "Source label only"}</td></tr>)}</tbody></table></div><p className="mt-3 text-sm text-muted">Emoji decorations are ignored. The migration pins existing Blacklist and No Invite definitions so renaming them preserves exclusions. Other label changes need a mapping update. Automatic attendance labels and personal notes are excluded.</p></section>
    </>}
    {tab === "Exclusions" && <section className={card}><h2 className="text-xl font-semibold">Blacklist and No Invite</h2><div className="mt-5 grid gap-4 md:grid-cols-2"><div className="rounded-xl bg-danger-soft p-5"><h3 className="font-semibold">Person is not in Customer.io</h3><p className="mt-2 text-sm">Do not create a profile while any Guestbook marketing restriction is active, including Blacklist or No Invite.</p></div><div className="rounded-xl bg-subtle p-5"><h3 className="font-semibold">Person already exists</h3><p className="mt-2 text-sm">Update the source restriction flags so the person can be excluded from invitations. Keep their existing consent and unsubscribe settings.</p></div></div>
      <p className="mt-5 text-sm">The Source exclusions segment must be excluded from relevant campaigns before rollout. A flag or segment alone does not stop a campaign.</p>
      <p className="mt-3 text-sm text-muted">Restrictions also include identity conflicts, inactive addresses, fresh undeliverable results, Luma restrictions and explicitly mapped calendar opt-outs. Removing a Guestbook restriction never subscribes someone.</p>
      <button onClick={() => setTab("Preview")} className="mt-5 rounded-lg bg-brand px-4 py-2 text-white">Check one person</button>
    </section>}
    {tab === "Preview" && <section className={card}><h2 className="text-xl font-semibold">Preview one profile</h2><p className="mt-2 text-sm text-muted">Reads the Guestbook index and the last delivered answer state. Does not contact Customer.io or send this payload. Deployment and the queue migration are required.</p>
      <form className="mt-5 flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void inspect("preview"); }}><label className="flex min-w-64 flex-1 flex-col gap-2 text-sm">Exact email<input required type="email" autoComplete="off" value={email} onChange={e => { setEmail(e.target.value); setPreview(null); }} className="rounded-lg border border-border bg-surface px-3 py-2" /></label><button disabled={busy} className="self-end rounded-lg bg-brand px-5 py-2 text-white">{busy ? "Loading…" : "Preview update"}</button></form>
      {preview && <div className="mt-6 space-y-4"><div className="flex flex-wrap gap-3 text-sm"><span>Marketing restriction: <strong>{preview.attrs.finc_luma_marketing_blocked ? "Yes" : "No source restriction"}</strong></span><span>Answer review: <strong>{preview.attrs.finc_luma_answer_review ? "Required" : "None"}</strong></span></div><p className="text-sm text-muted">Older conflicting answers ignored: {preview.olderAnswersIgnored?.join(", ") || "None"}. An unrestricted source record is not marketing consent.</p><pre className="max-h-[36rem] overflow-auto rounded-xl bg-subtle p-4 text-xs">{JSON.stringify(preview.attrs, null, 2)}</pre></div>}
    </section>}
    {tab === "Health" && <section className={card}><h2 className="text-xl font-semibold">Delivery status</h2><p className="mt-2 text-sm text-muted">Check mode, pending work, held profiles and source coverage on demand.</p><button disabled={busy} onClick={() => void inspect("health")} className="mt-5 rounded-lg bg-brand px-4 py-2 text-white">{busy ? "Loading…" : "Read status"}</button>{health && <pre className="mt-5 overflow-auto rounded-xl bg-subtle p-4 text-sm">{JSON.stringify(health, null, 2)}</pre>}</section>}
  </main>;
}
