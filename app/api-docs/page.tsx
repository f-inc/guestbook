import type { Metadata } from "next";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Fragment_Mono, Instrument_Sans, Instrument_Serif } from "next/font/google";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";
import styles from "./page.module.css";

const sans = Instrument_Sans({ subsets: ["latin"] });
const serif = Instrument_Serif({ weight: "400", subsets: ["latin"] });
const mono = Fragment_Mono({ weight: "400", subsets: ["latin"], variable: "--docs-mono" });
export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "API documentation · Guestbook",
  description: "Connect to Guestbook. Explore events, live guest lists, and a person’s indexed event history with the read-only integration API.",
  alternates: { canonical: "/api-docs" },
};
const chapters = [
  { heading: "Authentication", id: "authentication", title: "Authenticate your requests", label: "Authentication" },
  { heading: "Setup and administration", id: "administration", title: "Manage integration access", label: "Key management" },
  { heading: "GET /events", id: "events", title: "List events", label: "List events", endpoint: "/events", source: "Indexed catalog", summary: "Discover events and their sync freshness." },
  { heading: "GET /events/{eventId}/guests", id: "event-guests", title: "Get an event’s guests", label: "Event guests", endpoint: "/events/{eventId}/guests", source: "Live from Luma", summary: "Read registrations, approvals, and check-ins." },
  { heading: "GET /people/{personId}/events", id: "person-events", title: "Get a person’s event history", label: "Person history", endpoint: "/people/{personId}/events", source: "Guestbook index", summary: "Find one person’s indexed event memberships." },
  { heading: "Pagination and errors", id: "pagination", title: "Pagination & errors", label: "Pagination & errors" },
];

export default async function ApiDocs() {
  // Both the repository guide and public page use this file. Keep runtime reads
  // out of the request path: Next renders this public reference at build time.
  const guide = await readFile(path.join(process.cwd(), "docs/integration-api.md"), "utf8");
  const sections = new Map(guide.split(/^## /m).slice(1).map(section => {
    const newline = section.indexOf("\n");
    return [section.slice(0, newline).trim(), section.slice(newline + 1).trim()];
  }));
  return <main className={`${styles.page} ${sans.className} ${mono.variable}`}>
    <a className={styles.skip} href="#reference">Skip to API reference</a>
    <header className={styles.header}>
      <a href="/" className={styles.wordmark}>Guestbook<span> / Developers</span></a>
      <a className={styles.button} href="/admin">Manage API keys <span aria-hidden="true">↗</span></a>
    </header>
    <div className={styles.hero}>
      <div><p className={styles.eyebrow}>INTEGRATION API <span>v1 · Read only</span></p>
        <h1 className={serif.className}>Your events.<br />Connected.</h1>
        <p className={styles.lead}>Bring events, guest lists, and person history into the tools you already use.</p>
        <p className={styles.description}>Public documentation. Authenticated data. Every request respects your API key’s permissions and event access.</p>
      </div>
      <div className={styles.quickstart}>
        <p className={styles.eyebrow}>YOUR FIRST REQUEST</p><h2>Start with your event list.</h2>
        <p>Create a key in <a href="/admin">API management</a>, save it on your server, then make a request.</p>
        <CodeBlock>{`curl 'https://guestbook.f.inc/api/v1/events?limit=10' \\\n  -H "Authorization: Bearer $GUESTBOOK_API_KEY"`}</CodeBlock>
        <p className={styles.caption}>Never put integration keys in browser JavaScript.</p>
      </div>
    </div>
    <div className={styles.base}><span>BASE URL</span><code>https://guestbook.f.inc/api/v1</code></div>
    <div className={styles.overview} aria-label="Choose an endpoint">
      {chapters.filter(chapter => chapter.endpoint).map(chapter => <a href={`#${chapter.id}`} className={styles.card} key={chapter.id}>
        <span className={styles.cardTop}><span className={styles.badge}>GET</span><span aria-hidden="true">↘</span></span>
        <h2>{chapter.title}</h2><p>{chapter.summary}</p><span className={styles.caption}>{chapter.source}</span>
      </a>)}
    </div>
    <div className={styles.layout} id="reference">
      <aside className={styles.sidebar}><nav aria-label="API documentation"><p className={styles.eyebrow}>ON THIS PAGE</p>
        {chapters.map(chapter => <a href={`#${chapter.id}`} key={chapter.id}>{chapter.label}</a>)}
      </nav><p className={styles.sidebarNote}>Looking for someone’s history? Start with <a href="#person-events">Person history</a>.</p></aside>
      <article className={styles.reference}>
        {chapters.map(chapter => {
          const content = sections.get(chapter.heading);
          if (!content) throw new Error(`Missing API documentation section: ${chapter.heading}`);
          const body = <Markdown remarkPlugins={[remarkGfm]} components={{
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
          }}>{content}</Markdown>;
          return <section id={chapter.id} key={chapter.id} className={styles.chapter}>
            <>
              <h2 className={serif.className}>{chapter.title}</h2>
              {chapter.endpoint && <div className={styles.endpoint}><span className={styles.badge}>GET</span><code>{chapter.endpoint}</code><span className={styles.source}>{chapter.source}</span></div>}
              <div className={styles.prose}>{body}</div>
            </>
          </section>;
        })}
      </article>
    </div>
    <footer className={styles.footer}><a href="/">Guestbook</a><span>Founders, Inc.</span><a href="/admin">Manage API keys ↗</a></footer>
  </main>;
}
