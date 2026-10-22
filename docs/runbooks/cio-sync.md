# Luma to Customer.io

Prepared, disabled by default. No production migration, backfill, schedule,
profile write or Customer.io backfill has been performed by this code change.
Shadow segments can be prepared separately before deployment.

## What this implements

Existing signed Luma webhooks and a bounded API scanner update Guestbook. Database
triggers enqueue affected emails in the same source transaction. A scheduled
worker projects current event facts to Customer.io and records delivery progress.
No second database, new production service or persistent Node timer is required.
The scanner never deletes Guestbook guests. Completed scan coverage is stored
separately and used only when deriving Customer.io attributes.

This is an attribute sync. Existing `event_registered`, `event_approved`, and
`event_checked_in` history is retained; this release does not append to it. The
new shadow audiences use current source state, so cancelling an approval or
undoing a check-in removes that current membership. This also avoids replaying
old registration automations or duplicating prior imported events.

It never sends messages or writes subscription/consent, application, portfolio,
location or self-reported profile fields. However, creating a profile or updating
attributes CAN trigger existing Customer.io automations. Audit those consumers
before turning on delivery. Registration does not establish newsletter consent.

## Rollout

1. Verify the production database and hosting project with the technical owner.
   Back up the database. Review and explicitly authorize the exact additive
   `prisma/manual-migrations/20261022_cio_projection.sql`, then apply it and
   regenerate Prisma. Earlier email-health/removal tables must already exist.
   **Do not use `db push`: it cannot install the triggers or partial queue index.**
2. Deploy with all four `CIO_SYNC_*_ENABLED` flags false. Applying the migration
   captures future changes but performs no backfill or outbound request. The
   additional event metadata webhook handling is gated by the source flag;
   guest webhooks continue through Guestbook's existing handler.
3. Verify the CIO workspace permits email identification and both API keys belong
   to that same workspace/region. Review active profile-created, attribute-change
   and segment-entry automation dependencies. Start with
   `CIO_SYNC_PROFILE_MODE=existing_only`. In particular, an audience such as
   "email exists and double_optin is missing" can email newly imported people.
   Keep profile creation off until those entry paths are reviewed and corrected.
4. Dry run one authorized profile: authenticated `POST /api/cio/sync` with
   `{"action":"preview","email":"test@example.com"}`. This reads the index and
   returns the proposed attributes/hash without queue writes or external calls.
   The response contains event facts; do not publish it.
5. Configure the correct region, server-only Customer.io Track credentials and
   `CUSTOMERIO_APP_API_KEY` with read access for email-to-profile resolution.
   Set `CIO_SYNC_ENABLED=true`, `CIO_SYNC_SEND_ENABLED=true`,
   `CIO_SYNC_IDENTITY_CONFIRMED=email_lookup`, `CIO_SYNC_AUTOMATIONS_REVIEWED=true`,
   `GUESTBOOK_ENVIRONMENT=production`, and exact-email `CIO_SYNC_ALLOWED_EMAILS`.
   Keep `CIO_SYNC_FULL_ROLLOUT=false`. Vercel previews are refused even if they
   have production secrets. Production here is an explicit runtime identity,
   not a substitute for verifying the actual database target.
6. Set `CIO_NEWSLETTER_CALENDAR_IDS` to the explicitly chosen calendars whose
   opt-outs should block newsletter targeting. Add the new negative source flag
   to marketing exclusions and prepare shadow segments below before expansion.
7. Separately authorize historical/source writes, then set
   `CIO_SYNC_SOURCE_ENABLED=true` to reconcile Luma and
   `CIO_SYNC_BACKFILL_ENABLED=true` to seed the existing Guestbook index.
   Seeding enqueues at most 200 emails per call and commits its cursor with that
   batch. Re-running the completed seed is a no-op; live triggers continue.
8. Schedule `GET /api/cio/cron` every minute with a 32+ character bearer secret.
   External schedulers use `CIO_SYNC_SECRET`; Vercel uses `CRON_SECRET`. The
   optional `deploy/cio-vercel.example.json` is a template, NOT an installed
   schedule. Verify the host's cadence and 60-second invocation support.
9. Compare source and destination for a canary: registration, waitlist, approval,
   cancellation, event cancellation, check-in undo, changed email, duplicate
   update, timeout, 429, and a restart halfway through a guest list. Confirm
   no subscriptions or message journeys changed. Compare all target-event counts
   and the complete accessible-calendar inventory before claiming full coverage.
10. Approve full rollout, then set `CIO_SYNC_FULL_ROLLOUT=true`. Only after
    resolving new-profile message entry paths and validating a synthetic new
    person, set `CIO_SYNC_PROFILE_MODE=create_reviewed`. Missing profiles held
    during the existing-only phase retry automatically within 15 minutes.
    Switch audience
    consumers after count comparisons. Retain old segments until their consumers
    have migrated. Never assume an unused-looking segment has no dependencies.

## Shadow segment contract

Creating these definitions does not connect them to messaging. Use
`finc_luma_schema_version = 1` as an additional required condition on each
shadow audience. Definitions can exist before the first profile is synced;
zero members then is expected. The generic initial set is Registered, Verified
attendance, Repeat attendees and Source exclusion. Choose actual event IDs and
a recency window before adding event-specific or recent-attendee segments.

| Audience | Rule |
| --- | --- |
| Registered | `finc_luma_registration_count > 0` |
| Verified attendance | `finc_luma_checkin_count > 0` |
| Active for an event | `finc_luma_active_event_ids[]` equals event ID |
| Approved now | `finc_luma_approved_event_ids[]` equals event ID |
| Waitlisted now | `finc_luma_waitlisted_event_ids[]` equals event ID |
| Checked in | `finc_luma_checked_in_event_ids[]` equals event ID |
| Repeat attendees | `finc_luma_checkin_count >= 2` |
| Recent attendees | `finc_luma_last_checked_in_at` within the desired window |
| Source exclusion | `finc_luma_marketing_blocked = true` OR `finc_luma_identity_review = true` |

An invite to the next edition combines a verified prior-event audience and NOT
active for the next event. Use negative membership only after that target event's
snapshot is complete. Missing data is not proof of non-registration. Always keep
the current confirmed-consent, topic, global suppression and campaign-specific
staff/portfolio exclusions. This adapter never clears CIO-native suppressions.

`finc_luma_event_records` holds event IDs, names, category, dates, registration time,
current approval, verified check-in and cancellation. Arrays/counts are rebuilt,
never incremented. Dates are Unix seconds, as required by Customer.io's
[timestamp segment conditions](https://docs.customer.io/messaging/segmentation/faq-timestamps/).
Invites are not registrations; approvals are not attendance;
no-show labels are not inferred. Categories use the existing event field and need
an agreed taxonomy. Attending a robotics talk does not establish profession or
current location. Raw registration answers, private notes and interests are not
copied into CIO; those need an independently reviewed field-mapping contract.

## Coverage and monitoring

The scanner uses managed-event access from numbered `LUMA_API_KEY` credentials.
It does not use browser sessions, enumerate contacts, scrape partner lists, or
assume syndicated events grant access. Partner/session-only events require an
authorized API key or their existing approved import path. Calendar followers
who never registered are outside this event sync.

Each cron attempts at most four source pages and twenty projections with time
budgets. Guest pages hold at most 100 records. Recent and historical lanes have
independent persistent cursors per key. Completed recent walks restart after
15 minutes; historical walks after 24 hours. Large initial histories need many
invocations. Webhooks provide ordinary real-time updates. Add `event.created`,
`event.updated`, `event.canceled` to the existing signed subscription alongside
guest updates and calendar opt-outs. API reconciliation repairs missed or
out-of-order updates; beyond the recent window this waits for the history lane.
Customer.io delivery follows the next worker invocation and queue backlog; this
is near-real-time, not a sub-second guarantee. Monitor lag during initial backfill
and validate throughput against the expected event volume before expansion.
Delivery runs before backfill and scanning; a failure in one phase does not skip
the others. Live guest webhook updates and source suppression changes have queue
priority. Every fifth claim admits the oldest eligible work regardless of
priority, so the history queue also progresses. Cron returns 503 when a phase
fails while retaining each phase's result.

Authenticated `GET /api/cio/sync` exposes pending/quarantined and held-new-profile
counts, oldest pending
update, last API-accepted outbound delivery, seed completion, shared delivery pause,
and source cycles/errors. Queue age is retained across repeated source updates;
an unchanged projection does not pretend to be a fresh outbound success. Connect it to the
team's existing monitor before rollout. Alert on sustained pending lag, quarantine,
source failures, missing schedules and overdue cycles. No Slack notification is
sent by this implementation. Cron responses contain aggregate counts, no emails
or provider response bodies.

`finc_luma_indexed_records_complete` describes the person's observed event records,
not access to every calendar or completion of all history. Inspect source cycles
and event inventory separately. Profiles exceeding 1,000 rows or 60 KB fail visibly
rather than truncating. Changed emails/conflicting registrations are marked for
identity review; resolve them using existing CIO identities before marketing.

## Recovery and rollback

Cursor advancement follows successful page persistence. A replayed page is safe.
Incomplete pages cannot establish absence. After the final page, a monotonic
coverage cutoff excludes unseen older registrations from CIO's projection while
keeping the original Guestbook rows. Newer webhook observations survive, and
reappearing guests requeue even if their registration fields are unchanged.
Source errors retain cursors. A denied event requires owner attention and may
hold up its calendar lane; other configured calendars continue independently.

Delivery leases prevent concurrent processing of an address. Acknowledgements
advance only the claimed revision; changes during delivery remain pending.
Before each changed projection, the App API resolves the exact email. Exactly
one matching profile is updated by immutable `cio_id`, with `_update=true` and
without `email` or `id` in the body. Missing profiles stay pending by default;
multiple matches or source identity conflicts on a new person require review.
Even reviewed creation never assigns an external ID or changes consent. Both
App and Track failures use the shared retry/pause policy. The APIs may accept
a request before it is processed, and a profile deleted between lookup and
write can cause a dropped update; verify destination attributes in the canary
and monitoring, rather than treating HTTP success as membership confirmation.

Full-state PUTs are safe to retry after ambiguous network failures. Retries honor
`Retry-After`; 429 pauses all subsequent queue claims until the shared retry time.
401/403 pauses delivery pending credential review, so unrelated profiles are not
quarantined one after another. Other permanent 4xx or ten attempts quarantine work.
In-flight requests can still finish when another worker observes a rate limit.
After fixing the cause, review and requeue only affected addresses using
`SELECT cio_mark_email(...)`. After reviewing credentials, reset only the
`delivery` control row's JSON to `{}` to release an authentication pause.
A new full seed requires a reviewed reset of the `seed` control row JSON to `{}`.

Disable `CIO_SYNC_SEND_ENABLED` to stop delivery. Disable source/backfill flags
and schedule as needed; retain additive tables for recovery. Disabling a worker
does not erase delivered attributes or unsend messages triggered elsewhere.

## Validation

Run `npm run typecheck` and the normal suite. If the `tsx` CLI cannot open its
local IPC socket, use `node --import tsx --test` with the same test globs. SQL
tests run PGlite entirely in memory, generate the baseline schema without any
database connection, and apply the real migration. No configured application
database is touched. Production credentials, webhook delivery, scheduling, exact
coverage and segment latency still require the rollout checks above.

## Review handoff

The prepared SQL is an initial, unapplied migration. If an earlier draft was
manually applied elsewhere, do not rerun it; prepare and review a targeted upgrade
for that exact schema. The two new columns in this revision are queue `priority`
and `pending_since`; function definitions changed too.

| Work | Status / owner |
| --- | --- |
| Sync implementation, isolated tests, build, segment rules | Prepared by Codex |
| Draft PR and follow-up code fixes | Published separately on the feature branch; production stays unchanged |
| Review actual CIO IDs, existing segments and message dependencies | Mixed email-only/custom-ID profiles require exact-email lookup; creation remains gated by automation review |
| Shadow segments and membership comparison | Definitions can be prepared before deploy; real source/destination count comparison follows the canary |
| Verify hosting project, database target, backups, API keys and scheduler | Technical owner with deployment/database access |
| Apply the production migration | Requires explicit authorization for the verified target, per AGENTS.md |
| Canary, inventory/count reconciliation, monitoring and rollout | Joint final checks after deployment; not completed locally |

## Identity API references

- [App API exact-email lookup](https://docs.customer.io/integrations/api/app/tag/customers/getpeopleemail/)
- [Track profile updates and update-only behavior](https://docs.customer.io/integrations/api/track/tag/track-customers/identify/)
