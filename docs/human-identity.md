# Human identities in Guestbook

## Contract

`GuestbookPerson.personId` is a permanent `human_<uuid>` owned by Guestbook. It
has no dependency on an email address or provider account ID. The human owns the
preferred profile, notes, tags, audience membership, and person-level statistics.
The database model supports people with no external account.

Original `LumaPerson` and `LumaEventGuest` rows remain provider evidence.
`guestbook_account_identities` associates each source account with one human.
`guestbook_person_emails` associates all observed addresses with that human;
addresses may be shared by different humans. Email verification, opt-outs, and
removal evidence remain address-specific. The same email never automatically
merges people.

Application queries use the human index in human mode. The adapter retains the
old Prisma delegate names for existing callers, but selects the explicit
`GuestbookPerson`, `GuestbookEventGuest`, comment, and tag models. Parameterized
SQL selects the equivalent canonical tables. Ingestion uses the explicit source
client, then projects the affected accounts into the human index in the same
transaction. A shared identity transaction lock serializes merges, business
mutations, and source projection. Unknown accounts create provisional humans.

One human/event row summarizes original registrations. Check-ins take precedence,
then accepted/pending participation. Answers, socials, and searchable evidence are
combined. Source registration IDs remain the targets of Luma actions. The merge
preview shows original account details and original registration counts, while
history and person-level totals count each event once. Source scans remain bounded.

Directories, search (including account/email aliases), event cohorts, exclusions,
manual and automatic tags, bulk selection, counts, and exports through their
existing query paths all use human IDs. Invitations deduplicate humans before
choosing one address that passes verification, removal, and target-calendar
opt-out policy. A shared address needs an explicit human selection. Email-health
screens continue to show addresses rather than collapsing their restrictions.

The v1 guest/history APIs return human IDs in human mode. Existing account IDs
and retired human IDs resolve to the surviving person; event-local guest IDs
resolve within the API key's allowed events before expanding history. Existing
email and event permissions still apply. Live guest reads fail explicitly if a
source registration is not yet indexed, rather than returning account IDs mixed
with human IDs.

## Merge and undo

A merge preserves the chosen human ID and its preferred profile, combines tags
and available profile details, redirects the retired ID, moves account ownership,
and retains an audit snapshot. Source accounts and registrations are not rewritten.
It is limited to 100 linked source accounts per reviewed merge. Undo checks the
recorded identity versions and account mapping; newer merges must be undone first.
Existing note bodies/edits survive, and notes created after merging remain on the
survivor. Post-merge manual tag changes are replayed when restoring the survivor.
Automatic tags are refreshed separately; a saved merge is reported as saved even
if that derived refresh is pending. Event and audience caches are invalidated.

Existing confirmed account merge groups seed one human each. The previous
account-merge ledger is retained as migration evidence, while new merge/undo
operations use the human ledger. The rollout does not guess additional duplicates.

## Production rollout (not automatic)

The default remains `GUESTBOOK_IDENTITY_MODE=legacy`. Implementation is not
permission to run a production backfill. Do not use `prisma db push` here.

1. Verify the actual production target, source counts, current confirmed merge
   groups, and every writer (web deployment, workers, local development sessions).
   Pause source synchronization and business/merge writes for the copy and cutover.
2. Take and verify a **data and schema backup**, with a recovery location and
   manifest. Retain both original source data and canonical business data.
3. With explicit authorization for that target, apply these reviewed files in order:
   `prisma/manual-migrations/20261116_add_human_identity.sql`, then
   `prisma/manual-migrations/20261116_human_projection.sql`.
   The first transaction copies notes and tag history and creates an independent
   person per confirmed source group. It has 5-second lock/120-second statement
   limits and never updates original people/registrations. The second installs
   bounded projection and address-policy views.
4. Supply `DB_URL` securely in the command environment; do not place credentials
   on the command line or print them. Run `npx tsx scripts/human-identity.ts` for
   a read-only manifest and target fingerprint. Backfill explicitly with
   `npx tsx scripts/human-identity.ts --apply --target-fingerprint=<fingerprint>`.
   Projection commits at most 250 people per batch and is resumable by rerunning.
5. Require zero unmapped accounts, invalid human IDs, missing/orphan human events,
   or split confirmed groups. Verify notes, tags, source checksums/counts, sample
   histories, alias searches, and audience exclusions against the original data.
   Do not activate if the manifest fails or source writers changed during the copy.
6. While writes are still paused, set `GUESTBOOK_IDENTITY_MODE=human` for the
   finalization process and run the same approved backfill command with
   `--finalize`. It rebuilds automatic tags and event caches using human identities.
   Configure **every** application/worker/development writer for human mode before
   resuming any writes. Restart affected runtimes so account-era client/server
   caches cannot be reused. Deploy the human-capable code and verify authenticated
   reads before admitting writes. Reload existing browser sessions.
7. Verify one directory row per human, source-preserving sync, scoped API history,
   shared-event counts, tag exclusions, delivery eligibility and undo using an
   isolated fixture; do not merge real people merely as a production smoke test.

Before any human-owned writes, leaving legacy mode enabled is a safe postponement.
If legacy writers resume between migration and cutover, the canonical copy becomes
stale. Reconcile subsequent legacy profile, note, and tag changes before activation;
rerunning the projection backfill alone refreshes event evidence, not those
human-owned business records. With writers paused and a fresh backup, the reviewed
`20261116_reconcile_human_cutover.sql` performs that pre-activation copy while
preserving human IDs. It requires `SET guestbook.cutover_approved='true'` in its
session and rejects changed human identity ledgers or incomplete account mappings.
Never run it after enabling human-mode business writes. Recheck all mappings and validation after pausing
writers again. Do not treat an earlier successful manifest as cutover readiness.
After human mode accepts business writes, **do not simply flip back to legacy or
drop the canonical tables**: new notes, profile edits and tags live there. Roll
back to human-capable code, retaining canonical data and ledgers. Any reverse data
migration requires a separately reviewed reconciliation and backup.

## Isolated verification

Initialize a fresh PostgreSQL 17 cluster with no TCP listener and a private Unix
socket under `/tmp/guestbook-human-*/socket`. Initialize the legacy schema from
commit `8451480` (Prisma `db push --skip-generate` against that explicit isolated
URL). Set `HUMAN_IDENTITY_TEST_DATABASE_URL` to that fixture only and run:

```
npx tsx --test app/api/luma/human-identity-db.test.ts app/api/luma/human-mode.test.ts
```

The integration test checks the server's actual data directory before resetting
fixture data. It tests the real migration SQL, confirmed-group import, canonical
queries, live/scoped APIs, shared-email ambiguity, invitation fallback, human-owned
notes/tags, merge/undo, concurrent source sync, and preserved original records.
Without the explicit isolated URL it skips; it never falls back to `DB_URL`.

## Merge review and the Undo window

Pressing **M** immediately hides the reviewed pair and overlapping suggestions,
then shows a five-second countdown toast with **Undo**. This is an in-memory UI
draft, not a merge job: no merge request is sent and no queue or audit entry is
persisted during this window. Undo removes the draft entirely and restores the
original rows immediately. It does not create a cancellation or reversal record.
Leaving the page before the window expires also discards these drafts.

Only after five seconds does an uncancelled confirmation become a persisted
browser-outbox job and begin saving. Each rapid confirmation has its own full
window. The worker saves separate merges serially while review remains enabled.
The user-facing Undo shortcut and toast action cancel pending drafts only; they
do not issue an immediate merge followed by a compensating unmerge.

The **Recently merged** tab shows successful completed merges only. Drafts,
queued work, failures, cancellations, and reversed historical operations are
excluded. The server returns the latest 20 non-reversed audit operations; the
client combines these with successful recent saves, deduplicated by operation ID.
Search, matching rules, coverage, and shortcuts live in the sidebar. Review rows
expand in place for full evidence, source accounts, notes, and event history.

After the window expires, the outbox runs while this page is open and resumes
interrupted jobs on reopening the same browser/origin. Web Locks prevents two
station tabs from overwriting it. Persisted data contains IDs and statuses,
not contact details or credentials. Uncertain requests show a safe retry in the
sidebar, outside completed history. A client UUID doubles as the server audit ID,
so repeated requests recover the existing result instead of applying a merge
twice. Existing saved-merge reversal support and audit records remain for recovery
and compatibility, but draft cancellation never invokes them. No schema change
is needed.
