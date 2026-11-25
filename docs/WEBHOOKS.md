# Webhook-driven event updates

Luma → signed delivery → PostgreSQL inbox → supervised worker → indexed rows →
PostgreSQL NOTIFY → authenticated browser SSE.

Routine catalog, guest and activity reads use the index. Empty or unavailable
indexes never start Luma scans. Browser focus and one-minute guest refreshes no
longer check Luma. Stream heartbeats perform no queries; reconnects reload indexed
state to recover missed notifications.

Audience caches check the committed delivery revision on demand so separate or
suspended server instances also serve fresh data. Email delivery/verification and
job-progress schedules are separate from this event/guest synchronization path.

## Coverage

- `guest.registered`, `guest.updated`: registrations, check-ins/undone check-ins,
  approval/waitlist/decline, answers and ticket changes.
- `guest.refunded`: reconcile the guest after a Luma refund.
- `event.created`, `event.updated`, `event.canceled`: event lifecycle. Cancellation
  preserves history and a tombstone while removing the active catalog row.
- `calendar.event.added`: discover calendar additions. External events are ignored;
  inaccessible syndicated events fail visibly rather than triggering broad scans.
- `calendar.person.unsubscribed`: mirror opt-outs within the calendar bound to the
  verified signing secret.

The worker fetches only the notified event and, for guest updates, one guest by ID,
using the API key paired with the signing secret. Reading current state makes
delayed deliveries safe. One advisory lock serializes worker projections.

The provider subscription must request every supported type above, including
`guest.refunded`; implementing a handler does not enable its Luma subscription.
Unrelated ticket, subscriber and pending-submission events are acknowledged and
ignored. They do not create inbox rows or send messages.

Luma does not notify profile-only name/email/avatar edits or direct Stripe refunds.
Session-only events outside subscribed calendars are outside this pipeline. Use
explicit bounded recovery for these cases and historical backfills. A webhook is
not proof that historical guest coverage is complete; the UI discloses this.

## Production cutover

1. Verify the deployment and database, take/verify a recovery snapshot, review
   `prisma/manual-migrations/20261122_webhook_inbox.sql`, and obtain explicit
   authorization to apply it. It adds nullable columns and a partial index to the
   delivery ledger; it does not rewrite guest/event records. Apply only that SQL
   to the verified target, never a production schema push.
2. Set server-only `DB_NOTIFY_URL` on web and worker to a direct or **session-mode**
   connection for the same database as `DB_URL`. LISTEN cannot use transaction
   pooling. Port 6543 / `pgbouncer=true` is rejected; verify custom pool endpoints.
   `DB_URL` keeps its normal pooling; a session URL is accepted as listener fallback.
   Supply the database provider's trusted PEM certificate in `DB_NOTIFY_CA_CERT`
   for certificate and hostname verification on private-CA database connections.
3. Deploy the web app and a **persistent, supervised** process running
   `npm run webhooks:worker` from the same release. The worker needs both database
   settings, matching identity mode, paired `LUMA_API_KEY[_N]` credentials and
   opt-out calendar mappings. Enable supervisor restart on failure. The existing
   tracking worker does not run this process; Vercel functions alone are insufficient.
4. Allow machine POSTs at `/api/luma/webhooks` through browser challenges and
   deployment protection, while keeping signature verification mandatory. Once
   secrets are installed, an unsigned diagnostic with a valid-looking delivery ID
   must return JSON 401, never an HTML challenge. Do not send fake accepted events
   to production.
5. Add a subscription for every managed Luma calendar, using the supported actions
   above and the production `/api/luma/webhooks` URL. Preserve other integrations.
   Securely install the generated secret as `LUMA_WEBHOOK_SECRET[_N]`; its suffix
   must match `LUMA_API_KEY[_N]` and `LUMA_WEBHOOK_CALENDAR_ID[_N]`. Pause the new
   subscription until web and worker settings are deployed, then enable it.
6. Check authenticated `GET /api/luma/webhooks`: configured and workerActive must
   be true, with no unexplained dead deliveries or aging pending work. Follow the
   next legitimate registration/check-in through Luma acknowledgement, processed
   ledger entry, indexed guest state and an already-open browser update. Exercise
   event edits/cancellation on an authorized isolated test calendar.
7. Review historical coverage. Initial backfills remain separately authorized,
   bounded operations. Do not enable a recurring full-calendar scan.

## Failure and recovery

Ingress returns 202 only after payload and wakeup commit together. Delivery ID and
payload hash deduplicate retries; conflicting reuse returns 409. Invalid signatures
and malformed/oversized bodies are rejected. Database failures return 503.

The worker wakes on notifications, startup/reconnect recovery or the exact saved
retry/lease deadline. There is no idle polling loop. Retries start at 5 seconds,
back off to at most one hour, and become `dead` after 10 failures. External alerting
should monitor the authenticated status endpoint and worker error codes.

Successful deliveries discard payloads and retain metadata/hash. Pending/dead
payloads contain registration data: restrict access and follow the database's
existing retention/backup policy. Never export them to logs. Saved errors and logs
contain codes, not provider responses, identities, secrets or raw payloads.

After repair, an explicitly authorized operator can requeue a bounded, reviewed set
of dead delivery IDs: set status queued, attempts 0 and next_attempt_at NOW(), then
send `pg_notify('guestbook_webhook_inbox', '')` in the same transaction. No mass
replay or cleanup runs automatically. Keep the ledger during rollback; pause the
subscription, stop its worker and restore the prior app without dropping columns.

## Validation

`npm run test:webhooks` creates a disposable PostgreSQL cluster with TCP disabled,
verifies its data directory, applies the migration twice and tests ingress,
deduplication, claims, retries, crash recovery, current-state reconciliation,
cancellation, database-only reads and authenticated SSE. It never uses application
credentials. Requires `initdb` and `pg_ctl`. Unit tests cover fragmented SSE and
shared listener lifecycle. No production fixtures are created.

The additional scenario suite covers all supported signed envelopes, approval
states, check-in reversals, changed multi-select answers, re-registration, refunds,
event edits, cancellation tombstones, calendar-key isolation, invalid bodies,
ignored types, rate limits and retry recovery. It asserts that provider requests
only read the notified resources and that existing notes survive projection.

To repeat the same scenarios against Campus's actual schema and restricted
runtime role, supply its versioned migration files explicitly:

```sh
npm run test:webhooks -- \
  --campus-schema "$CAMPUS_GUESTBOOK_SCHEMA_SQL" \
  --runtime-role "$CAMPUS_GUESTBOOK_RUNTIME_ROLE_SQL"
```

This also runs both legacy and human identities in a separate disposable
database, verifies public decoy tables remain untouched, and tests the startup
schema after `RESET ALL`. The runner removes inherited database and provider
settings; migration files are applied only after verifying the temporary cluster.

For live checks, inspect active subscriptions and their event-type coverage,
verify the signing-secret/calendar pairing without displaying secrets, and compare
recent processed examples with read-only provider resource lookups. Signed
unsupported-type probes can verify the public receiver without inserting inbox
rows. Use isolated data for cancellation, opt-out and malformed-delivery cases;
never manufacture real attendee changes to test those paths.

## Shared Campus database compatibility

The receiver and workers can retain the existing webhook URL and subscription
secrets while connecting to a dedicated `guestbook` namespace in the Campus
database. Set `schema=guestbook` on `DB_URL` and every `DB_RUNTIME_URL`; retain the
same schema on all web and worker deployments. `DB_NOTIFY_URL` must connect to
the same database through a direct/session connection. LISTEN is database-wide,
so its client strips Prisma's schema parameter without changing where projections
are written.

Transaction-pooled request connections additionally use the PostgreSQL startup
option `-c search_path=guestbook,pg_catalog` (URL-encoded in the `options`
parameter). This keeps unqualified SQL in the intended namespace after pooled
session resets; Prisma's schema parameter alone is not a substitute. Notification
listeners continue to use the separate session connection.

Create the destination through Campus's versioned Supabase migration, not
`prisma db push` against the shared database. Copy and reconcile all records,
pending inbox payloads, retries, sequence positions and provider evidence before
switching writers. An initial snapshot alone cannot include changes committed
after it started. Keep one authoritative writer database and one projection-worker
owner through cutover. After the first destination write, a connection-only
rollback can lose data and must not be used without reconciliation.

## Coordinated database handoff

`DB_HANDOFF_ENABLED=true` opts requests and provider job cycles into a shared
source-database advisory gate. Configure `DB_HANDOFF_MIGRATION_ID` and both private
`DB_DESTINATION_URL` / `DB_DESTINATION_RUNTIME_URL` connections (`schema=guestbook`)
first. The source control identity must match, and destination routing requires
its verified, activated copy marker. With the flag omitted, existing routing is
unchanged. Never enable it before the source capture/fence is installed.

The final controller takes the exclusive gate, waits for in-flight operations,
locks source tables against writes, reconciles captured keys and sequences, and
verifies every row. New requests wait at the gate, then select the committed
destination. Callback failures never trigger automatic provider retries. Jobs
started with `after()` acquire their own gate; they cannot inherit an expired
request scope. Source triggers reject writes after handoff. Truncation is blocked
while capture is installed.

Keep the existing notification connections and worker ownership during rolling
preparation. Destination webhook acceptance relays a wakeup through the source
coordinator, and the worker relays index changes there until listener settings
are finalized. Do not run independent source/destination projection workers.
After the verified handoff, replace web/worker database and notification settings
with the destination connections and remove the handoff flag through a controlled
rollout. Retain the old source and private journal as recovery evidence; changing
URLs back after destination writes begin is not a rollback.
