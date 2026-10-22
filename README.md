# Guestbook

Guestbook is a compact event-ops console for Luma-backed communities. It gives teams one place to browse events, review guests, track attendance history, and build invite audiences without pulling an entire calendar or contacts database into the browser.

## What It Does

- Loads Luma events and guests through server-side API routes.
- Shows event lists, guest status, registration details, social/profile fields, and activity history.
- Supports approval, waitlist, decline, and invite workflows where Luma exposes those actions.
- Keeps a Prisma-backed activity index for faster guest lookup, profile traces, and sync observability.
- Provides bounded sync controls so large calendars can be refreshed deliberately.

## Stack

- Next.js App Router
- TypeScript
- React
- Tailwind CSS
- Prisma
- PostgreSQL
- Luma public API

## Quick Start

Create your local env file:

```bash
cp .env.local.example .env.local
```

Set the required values:

```bash
LUMA_API_KEY=your_luma_calendar_api_key
# Optional: add LUMA_API_KEY_2, LUMA_API_KEY_3, ... to aggregate managed events
LUMA_SESSION_TOKEN=your_luma_auth_session_cookie_value
# Optional: add LUMA_SESSION_TOKEN_2, LUMA_SESSION_TOKEN_3, ... as well
DB_URL=your_postgres_connection_string
GUESTBOOK_KEY=replace_with_private_guestbook_key
GUESTBOOK_SYNC_SECRET=replace_with_random_sync_secret
LUMA_WEBHOOK_SECRET=whsec_secret_from_luma
```

Create a Luma webhook in Calendar Settings → Developer that sends `guest.registered`
and `guest.updated` events to `https://your-guestbook.example/api/luma/webhooks`.
Use `LUMA_WEBHOOK_SECRET_2`, `LUMA_WEBHOOK_SECRET_3`, and so on when multiple
calendar webhooks use different signing secrets. Webhook delivery updates one guest
at a time; `/api/luma/sync` remains the bounded recovery and consistency scan.

Guestbook merges and deduplicates managed events from every configured API key and signed-in session token. API-key access is preferred when both credential types can access the same event; session-only events use Luma's bounded signed-in manager endpoints for event details and guest loading.

Install dependencies, prepare Prisma, and start the app:

```bash
npm run safe:install
npm run db:generate
npm run db:push
npx prisma db execute --file prisma/manual-migrations/20260721_add_automatic_archetype_tags.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/manual-migrations/20260723_add_event_catalog_state.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/manual-migrations/20260731_add_event_feedback_stats.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/manual-migrations/20260819_add_luma_webhooks.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/manual-migrations/20260903_preserve_accepted_guest_status.sql --schema prisma/schema.prisma
npm run dev
```

Open `http://localhost:3000`.

## Data Refresh

For the optional, disabled-by-default Luma to Customer.io audience sync, see
[the rollout guide](docs/runbooks/cio-sync.md). It adds a durable delivery queue,
resumable reconciliation, read-only preview, and health endpoints. Migration,
production writes, segments, and scheduling require separate rollout steps.

Guestbook refreshes the lightweight Luma event catalog on app load and when the browser tab becomes active. For the selected event, it compares Luma's approved, pending, waitlist, invited, declined, and checked-in counts with the local snapshot before fetching guests.

The former hourly full-sync Worker is archived. The `/api/luma/sync` endpoint remains available as a deliberate recovery or backfill command:

```bash
curl -X POST http://localhost:3000/api/luma/sync \
  -H "x-guestbook-key: $GUESTBOOK_KEY" \
  -H "Authorization: Bearer $GUESTBOOK_SYNC_SECRET"
```

The recovery job is intentionally capped by defaults in `.env.local.example`. Raise those limits only when you explicitly want a larger backfill.

### Automatic Tags

Every completed `/api/luma/sync` recovery run classifies people from the local PostgreSQL activity index. It does not make additional Luma requests. `Sync event` reevaluates affected people and automatically falls back to a full run when the latest public-event window changes.

The managed archetypes are `🚀 Superpower User`, `⚡ Power User`, `🎪 Festival Dweller`, `👻 Flaker`, and `💀 Superflaker`. `🎪 Festival Dweller` means the person's most recent known checked-in event has `festival` in its title; newer registrations and no-shows do not affect it. Automatic assignments are stored separately from manual tags and materialized into `luma_people.tags` for fast guest-table reads and filtering.

Preview a full classification without writing assignments:

```bash
curl -X POST http://localhost:3000/api/tags/auto \
  -H "x-guestbook-key: $GUESTBOOK_KEY" \
  -H "Content-Type: application/json" \
  --data '{"scope":"all","dryRun":true}'
```

Only successfully synced, non-truncated events are eligible. Public-event streaks use Luma's `visibility = public`; ongoing events wait until their recorded end time, or the configured settle interval when no end time is available.

## Safety Notes

Guestbook keeps Luma credentials server-side, avoids contacts/list endpoints, and writes redacted endpoint logs to `.debug/luma-api.log`. Local env files, logs, build output, and dependencies are ignored by Git.

Automatic tags write only to Guestbook's PostgreSQL database. They never update Luma guest records.

Event feedback is read from Luma only when a saved manager session token is available or the Feedback tab is opened. Multi-event feedback uses one Guestbook request with bounded upstream concurrency. The defaults allow up to 50 selected events, three concurrent Luma reads, and 1,000 responses per event; configure `LUMA_FEEDBACK_MAX_EVENTS`, `LUMA_FEEDBACK_CONCURRENCY`, and `LUMA_FEEDBACK_MAX_RESPONSES` to lower those limits.

Run the test suite with:

```bash
npm test
```

## Invitation tracking

Invitation outcomes are cached in Postgres. The selected events use Luma’s private
`/event/admin/get-invites` endpoint (20 invitations per page, opaque cursor). This
returns invitation IDs, creation times, opens and RSVP links—not email message IDs,
delivery receipts, clicks, bounces or spam reports. Missing opens mean “No open
recorded”, never a delivery failure. Bulk records are stored separately from message
history; refresh cannot erase stronger timeline evidence or overwrite a newer send.

“Refresh invitations” queues up to 20 explicitly selected events. Each worker batch
is bounded to 12 requests / 25 seconds with two-second pacing, a shared Postgres
lease, rate-limit cooldown and atomic page/cursor commits. Only those events refresh
again every 15 minutes; polling stops one day after an event ends. No contacts/list
calls or full-calendar scans occur. “Check email details” requests one recipient’s
timeline; new sends receive focused follow-up checks. Existing cached timelines and
confirmed suppressions are retained. RSVP remains separate from email outcomes.

Apply the additive migrations in order: `20261002_add_invitation_tracking.sql`,
`20261002_tracking_queue.sql`, then `20261003_bulk_invitation_tracking.sql` from
`prisma/manual-migrations/`, and regenerate Prisma. The last migration retires old
per-person scan queues and converts active explicit backfills to bulk event jobs.
Restart the server/worker after regenerating Prisma.

For updates while browsers are closed, run `npm run tracking:worker` as a supervised
process with the same `DB_URL` and a valid saved Luma session (or `LUMA_SESSION_TOKEN`).
It does not start another Next server or use a listening port. Browser refresh and
worker share a Postgres lease, which expires after a process crash. Invalid sessions
pause the credential and preserve cached results with a reconnect prompt.
Browser local-storage tokens take priority. After a successful tracking request, an
AES-256-GCM encrypted copy is stored in Postgres for background workers. Encryption
uses `LUMA_TRACKING_ENCRYPTION_KEY`, falling back to `GUESTBOOK_KEY`; all workers must
share that secret. No token is written to env files or logs. Rotating the encryption
secret requires a fresh browser submission.

Add `calendar.person.unsubscribed` to the existing Luma webhook subscription. Set
`LUMA_WEBHOOK_CALENDAR_ID` to that webhook's calendar ID, and matching
`LUMA_WEBHOOK_CALENDAR_ID_2`, etc. for numbered signing secrets. The verified secret
provides calendar scope because Luma's person payload does not contain it. Missing
scope returns 503 for retry instead of creating a global exclusion. Existing subscriptions
must be updated in Luma before opt-out notifications will arrive. Opt-outs remain labeled
“Opted out”; their payload cannot establish whether a spam report occurred.

No historical opt-outs are inferred from missing tracking. Cached results remain visible
when authentication fails. A successful timeline with no matching invitation says
“No tracking returned”; an unchecked invitation says “Tracking not loaded”.

On a long-running Node host such as Railway, alternatively set
`LUMA_TRACKING_WORKER_ENABLED=true` on the Next service and restart it. The Node
instrumentation hook then drains the durable queue every 30 seconds, without a
second service. Do not rely on this timer on request-only/serverless hosts. Run either
mode; the database lease also prevents duplicate work if both are accidentally enabled.


Email issues are grouped by address across events. Counts deduplicate failed email
message IDs; an issue flag without a cached message is not assigned an invented
count or failure time. Apply `20261003_invitation_issue_history.sql` and regenerate
Prisma to retain non-invitation failed emails separately from invitation messages.
Calendar removal remains a separate reviewed action.

### Community email verification

The Guests → Email issues page verifies unique addresses from Guestbook's indexed
people, event guests, and invitation records using Emailable. Set
`EMAILABLE_API_KEY` server-side and apply
`prisma/manual-migrations/20261004_email_verification.sql`, followed by
`prisma/manual-migrations/20261005_email_addresses.sql`, then regenerate Prisma.
Stop old application/worker processes while applying the second migration; it consolidates the old tables transactionally.
The UI reads the live Emailable credit balance every 30 seconds and on manual
refresh. The scan button displays the smaller of remaining credits and addresses
requiring verification. Start rechecks the balance and caps the queued run to both
the displayed count and the current balance. Each new provider batch also checks
credits; unavailable or exhausted balances pause the run. Opening the page never
submits a new paid scan; results less than 30 days old are reused. The balance
can also be spent by external clients, so it is checked again before each batch
but cannot be reserved atomically across separate Emailable integrations.

The provider receives batches of up to 1,000 addresses, keeping responses in JSON.
Jobs, batch IDs, partial results, and progress are persisted. The existing
`tracking:worker` process or `LUMA_TRACKING_WORKER_ENABLED=true` background worker
advances verification independently of the Luma session; while the page is open,
bounded requests can also advance an already-started job. Deploy a persistent
worker to finish and collect results when no browser is open. The batch lease
prevents concurrent submissions. Definitive failures pause for Resume; ambiguous
POST outcomes pause for operator reconciliation in Emailable before resubmitting.

Verification states are estimates, separate from recorded Luma bounces and spam
reports. Unknown results are never treated as deliverable. Recent undeliverable results block new Guestbook invitations through the same policy used by all send paths. Accept-all, risky, unknown and unchecked addresses remain sendable with uncertainty shown. Luma restrictions and calendar-specific opt-outs take precedence over verification. No person is archived and no contact is automatically removed.

`email_addresses` stores the latest verification and current local Luma restriction, keyed by normalized email; optional `personId` links to the indexed profile without making the person's identity depend on the address. `email_verification_checks` is append-only, retaining each distinct provider check (duplicate partial polls are deduplicated). Migration preserves the previously cached result as a baseline; overwritten historical results cannot be recovered. Per-event `luma_invite_tracking`, attempts, calendar opt-outs, and verification job/batch records remain separate because their scopes differ.

The invitation composer can verify just the selected audience. Full-list scanning remains available and is bounded by the displayed and freshly checked credit balances. Both reuse 30-day results; recorded Luma restrictions are skipped before queueing and again before provider submission. Audience scans also honor target-calendar opt-outs. Full-list scans have no target calendar, so calendar opt-outs remain contextual, not global blocks.

Guests → Email health shows each address's latest verification, reason, sending
decision and profile access. Verification history and Luma restriction checks
remain backend capabilities; they are not row actions in the current UI.
Historical bounce evidence remains separate from a current restriction. Scrubby
is not integrated.

Scope is the synced Guestbook list, not unsynced Luma contacts.
API references: https://emailable.com/docs/api/emails/ and
https://emailable.com/docs/api/authentication/.

### Confirmed calendar removals and inactive emails

Guests → Email health → **Remove blocked emails from Luma** previews selected
blocked addresses or all blocked addresses matching the search (up to 10,000
addresses / 50,000 calendar operations). Choose the connected calendars, review
addresses and reasons, then explicitly confirm. Drafts expire after 15 minutes.
Only Luma restrictions and fresh undeliverable verification qualify; uncertain
verification and calendar opt-outs alone do not qualify.

Apply `prisma/manual-migrations/20261005_email_removal.sql` only after reviewing
and obtaining approval for the target database, per AGENTS.md. Then set
`EMAIL_REMOVAL_ENABLED=true` and restart the service. Until then, removal is
visibly disabled and existing reads don't reference the new tables. This is an
additive migration; it does not remove or deactivate any contact. Take the
normal database backup before an authorized production application. Keep the
ledger tables if reverting the application: schema rollback cannot undo Luma
removals. Do not use `db push` instead of this migration; it creates two SQL views
and a partial unique index that Prisma does not represent.

The API key's calendar is verified with `/v1/calendars/get` before each
`/v1/calendars/contacts/remove` request. The job stores calendar identities and
key environment-variable names, never credentials. Calendar removal stops
calendar invitations/newsletters; it does not delete the Luma account or event
history. Other calendars are outside the selected scope.

`email_removal_jobs` and `email_removal_items` persist previews, confirmations,
claims and per-calendar results. A successful removal is not retried. Definitive
rejections can be retried explicitly. Timeouts, server failures and expired
worker claims become **unconfirmed** and require checking the contact in Luma
before a new request; they are never retried automatically. Current blocking is
rechecked before each removal. If an address no longer qualifies, it is skipped.
**Download CSV**, beside the removal status or inside removal details, exports
the entire saved job (not just the current page), including failed and unconfirmed
entries. Each row represents one email/calendar operation and includes its name,
email, calendar, reason, status, error, UTC timestamps and job ID. Downloads require
the Guestbook key and do not change records or retry requests.
After every selected calendar confirms success, `email_inactive` records the
email's inactive state. Partial successes remain excluded from new invitations
until reviewed, even if verification subsequently becomes deliverable.

Sync and verification never overwrite inactivity. `guestbook_inactive_people`
derives visibility from all known addresses: a person is hidden from directory,
name search and invitation audiences only if every known address is inactive.
Existing event attendance/history remains intact. A newly discovered active
address makes the person visible again; it does not reactivate old addresses.
The **Inactive** filter retains profile access. This release does not provide a
one-click restore, which would not re-add a contact to Luma.

Use a persistent Node deployment or the supervised `pnpm tracking:worker`
process. Enabled removals also have an in-process timer independent of browser
polling; a serverless instance that is suspended cannot keep a timer running.
The UI polls saved progress every 10 seconds. The worker processes up to five
operations per pass with database claims preventing duplicate dispatch.

Tests use mocked provider requests. Optional integration tests require
`EMAIL_REMOVAL_TEST_DATABASE_URL` pointing to a separately provisioned temporary
PostgreSQL socket under `/private/tmp/guestbook-removal-test-*`; they refuse the
normal application connection and verify the server's data directory before
fixture writes. Initialize the existing schema plus the removal migration there,
then run `node --import tsx --test app/api/luma/email-removal.test.ts`.


Removal previews are available in `next dev` even when `EMAIL_REMOVAL_ENABLED`
is unset. These previews query existing records only: they do not persist draft
jobs or change the shared database. Preview pagination is live, so its counts
may change while production cleanup runs. Confirmation and retries are disabled
in the development UI and rejected server-side; development workers cannot
claim or dispatch removal jobs either.

Executing removals requires `EMAIL_REMOVAL_ENABLED=true`, `NODE_ENV=production`,
and a production deployment identity (`RAILWAY_ENVIRONMENT_NAME=production`,
or `GUESTBOOK_ENVIRONMENT=production` on other hosts). Railway's environment
identity takes precedence. The existing preview-and-confirm flow still applies
in production. No new migration is required for this restriction.

### Campus form submissions

Configure server-only `CAMPUS_API_KEY` with the Campus `form-submissions.read` scope.
`CAMPUS_API_URL` defaults to `https://api.f.inc` and accepts an API origin (no path).
Authenticated Guestbook requests can query
`GET /api/campus/form-submissions?formKey=guest-confirmation&limit=50&offset=0`.
Optional `email` matches case-insensitively. The response contains `data` rows with
`id`, `form_key`, `form_version`, `created_at`, `name`, `email`, and `answers`, plus
`pagination.nextOffset` (null at the end). Pages are ordered newest first; concurrent
new submissions can shift offsets. The Campus key never goes to the browser.
Campus must deploy migration `20261013210000_form_submission_read_scope.sql` and the
new API endpoint before use; existing keys need the new scope explicitly granted.

The production key scope and Campus scope migration were applied on 2026-10-13.
The API and proxy code still need deployment. Requests from the local investigation environment to `api.f.inc` encounter a
Cloudflare browser challenge even with Inbox0's named User-Agent; hosted runtime
access has not been verified. The known Campus Railway origin authenticates this
key (whoami HTTP 200), but form-submissions returned HTTP 404 before deployment.
Verify `api.f.inc` from the actual Guestbook runtime before changing edge rules.

### Campus requests UI

Open `/requests` from the Guestbook header. Guestbook authentication is required. The page always filters to `event-request` and supports case-insensitive partial search across all submitted values, including nested custom answers. Search returns up to 25 matches per page, scanning at most 20 upstream pages per batch; “Next” resumes scanning when more records remain. Select a request to see its event details, organizer, and additional answers. The three initial example submissions are marked “Sample” by explicit request ID. No submissions are imported into the database or persisted in browser storage.

Campus form versions 6–8 identify portfolio/in-network hosting requests. These show
“In-network event request” and “Event budget” for food, equipment, and other costs
the host is covering; “None” is a valid answer. Versions 1–5 retain “Space budget”.
The version records the form context and does not verify portfolio membership.
Version 7 adds `foundersInvolvement` (four stable hosting/sponsorship enum choices)
and optional `involvementDetails` (up to 5,000 characters), stored in Campus’s existing
answers JSONB. The detail view shows the human label and organizer’s plans; versions
1–6 show “Not asked on this form version.” Missing version 7/8 answers are marked as
not provided, never assigned a default level of commitment. Unknown future answers
remain visible and HTML is escaped. Keep `app/requests/event-involvement.ts` in sync
with os-v2’s shared contract and os-web’s `src/lib/event-request.ts`. Deploy os-v2’s
version 8 validation before the new portfolio frontend; no database migration,
Prisma change, or backfill is needed in either service.

Version 8 replaces the portfolio equipment/support question with required
`eventDescription` (1–5,000 trimmed characters). Guestbook shows **Event goal &
itinerary** before the involvement section, preserving submitted line breaks and
escaping HTML. Old `specialRequests` stay labeled **Equipment & special requests**;
they are never interpreted as an event description. Both keys live in Campus’s
existing answers JSONB, and unknown answers remain visible.

Set the server-only `CAMPUS_API_URL=https://os-v2-production.up.railway.app`. Verified from the local Guestbook environment: Railway returned HTTP 200 for guest confirmations, while `https://api.f.inc` returned HTTP 403 with a Cloudflare browser challenge. The proxy retains its configurable origin and uncached reads. Restart a running production server after changing environment configuration.

The former `/form-submissions` URL redirects to `/requests`. Verified that the Campus event request form posts to `/api/event-requests` and persists `form_key=event-request`; the live integration returned two matching requests during verification.

Requests display company and event names together. Company icons use a protected, uncached server route: Google’s domain favicon service first, comparing against its generic placeholder, then the company LinkedIn page image when available. Redirects and image hosts are bounded to the provider hosts. If both sources fail or LinkedIn blocks access, company initials appear.
