# Guestbook integration API (v1)

Base URL: `https://guestbook.f.inc/api/v1`.

Guestbook runs on the existing Founders, Inc. Vercel project. Use
`https://guestbook.f.inc/admin` for API key management; the saved Guestbook login
is reused when you open `/admin` on the same domain. Browser storage is scoped
to the domain, so a login saved on another host is not shared automatically.

If a server request receives an HTML browser challenge instead of JSON, the
custom domain’s Cloudflare rule must allow the integration API routes through
while the Guestbook API continues to enforce Bearer authentication. Do not treat
an HTML challenge or a failed request as an empty guest list.

## Setup and administration

Open `/admin`, unlock with the existing Guestbook login key, and create a named
key for each application. Anyone holding that shared login key can administer
integration keys; Guestbook does not currently have individual admin accounts.
Integration keys cannot manage keys or access the existing internal APIs.

The complete integration key is returned once on creation. Only its SHA-256 hash
is stored. Keep the secret in your platform's server-side secret storage. The
admin page lists prefixes, permissions, event restrictions, and expiration;
revocation takes effect on the next request. Change permissions by creating a
replacement key, switching the integration, and revoking the previous key.

Permissions:

| Permission | Access |
| --- | --- |
| `events:read` | List events and sync metadata |
| `guests:read` | Read guest identities, statuses, timestamps, and person event history (history also requires `events:read`) |
| `guests:email` | Also return email addresses; requires `guests:read` |

Optional event IDs restrict both event listings and guest access. An empty list
allows all events, including future events. Keys can also have an expiration.
The admin form defaults to all three permissions for email integrations; remove
permissions you do not need. No integration write permissions are available.

## Authentication

Send `Authorization: Bearer YOUR_API_KEY` on every request. The API does not
accept login cookies, the shared Guestbook key, or query-string credentials.
All responses use `Cache-Control: private, no-store`. Use this API server to
server; do not embed integration secrets in public JavaScript.

```sh
curl 'https://guestbook.f.inc/api/v1/events?limit=100' \
  -H "Authorization: Bearer $GUESTBOOK_API_KEY"

curl 'https://guestbook.f.inc/api/v1/events/evt-example/guests?checked_in=true' \
  -H "Authorization: Bearer $GUESTBOOK_API_KEY"
```

## GET /events

Requires `events:read`. Includes every indexed event allowed by the key,
including inactive events (`catalogActive: false`). Returns explicit fields only:
`eventId`, `title`, `date`, `startsAt`, `endsAt`, `visibility`, `location`,
`category`, `capacity`, `lumaUrl`, `catalogActive`, `syncedAt`, `syncState`.

## GET /events/{eventId}/guests

Requires `guests:read`. Every request reads every Luma guest page for the selected event before applying
filters. With no filters, returns every current Luma guest status, including
statuses added in the future. The event must appear in Guestbook’s event index. Each guest includes `personId`,
`lumaGuestId`, `name`, `status`, `lumaApprovalStatus`, `operatorDecision`,
`registeredAt`, `invitedAt`, `approvedAt`, `checkedInAt`, `checkedIn`, and `updatedAt`. With `guests:email`, `email` is included (event registration email
first, then person email, otherwise null). Without that permission the email
field is omitted entirely. Phone numbers, private notes, raw payloads, profile
answers, and social links are never exposed.

Optional filters combine with AND:

| Parameter | Meaning |
| --- | --- |
| `status` | Exact normalized live status, e.g. `registered`, `going`, `checked_in`, `declined`, `waitlisted`, `invited` |
| `approval_status` | Exact live Luma approval status, e.g. `approved`, `pending_approval`, `declined`, `waitlist` |
| `operator_decision` | Exact stored Guestbook operator decision |
| `checked_in` | `true` if a live check-in timestamp exists; `false` for all others |
| `registered` | `true` if `registeredAt` exists; `false` if it is null |

Live approval statuses map to Guestbook status names (`approved` → `going`,
`pending_approval` → `registered`, `waitlist` → `waitlisted`), with ticket
check-in timestamps taking precedence as `checked_in`. Unrecognized approval
statuses pass through unchanged; a missing approval status becomes `unknown`.
`operatorDecision` is read from Guestbook, since it is a local field, and may be
null when there is no matching local guest. All other guest fields come from
Luma, not the guest index. No database data is changed by these reads. `status=registered` is an exact
status, not everyone who has ever registered. Use no status filter to fetch all
records and select the cohorts your platform needs. `registered=true` selects
records with a registration timestamp, which can be absent in historical data.
A decline alone does not prove whether a guest declined or an operator denied
them; inspect `lumaApprovalStatus` and `operatorDecision` as well. Statuses such
as no-show are not inferred at request time.

Guest responses include `source: "luma-live"`, `fetchedAt`, `complete: true`,
`totalGuests` (the number retrieved from Luma before filtering), `requestId`,
and `event: { eventId }`. `complete` means the entire upstream list was read
successfully; it does not mean every guest fits in the current response page.
Follow `pagination.nextCursor` to retrieve all matching guests.

The guest endpoint never serves a cached guest snapshot or silently falls back
to the database. Every request, including each continuation page, makes a fresh
Luma read. The event-list endpoint continues to read the indexed event catalog;
its `syncedAt`/`syncState` describe that index, not the live guest result.

Reads are bounded to one event, 10,000 guests, 200 upstream pages, 45 seconds,
and three simultaneous live scans per server process. These limits protect
Luma access without silently dropping recipients. Exceeding a size/page limit,
an incomplete/malformed page, or duplicate identities returns an error with no
guest list. Large events may need a dedicated export job before these limits
can safely be raised. Missing Luma server credentials returns 503, upstream
failures return 502, rate limits/concurrency limits return 503, and timeouts
return 504. Clients should retry 503/504 with backoff rather than treating them
as empty lists. Errors include a `requestId` for `.debug/luma-api.log`.

Registration is not email consent; the email platform must continue applying
its own suppression and unsubscribe rules.

## GET /people/{personId}/events

Fetch one person's event history. Use the `personId` returned by the event guest
endpoint, URL-encoding it in the path. Both `events:read` and `guests:read` are
required; `guests:email` controls email fields as usual. Existing keys with these
permissions work without being replaced. Email addresses and names are not
accepted as person IDs.

```sh
curl 'https://guestbook.f.inc/api/v1/people/usr-example/events?limit=10' \
  -H "Authorization: Bearer $GUESTBOOK_API_KEY"
```

Person history reads directly from Guestbook's database. It makes no Luma
requests, scans no calendars or contacts, and writes no data. Only requests for
a specific event's guest list perform a live Luma refresh.

Each history record contains the event's ID, title, date, start/end time,
location, URL, and catalog-active flag under `event`, plus the person's guest
ID, name, stored status, approval status, operator decision, registration/check-in
timestamps, and `syncedAt`. Check-in timestamps take precedence as `checked_in`;
no-show or other status changes are not inferred from the current time.
`source: "luma-index"` and `coverage: "indexed-person-events"` make the data
source explicit. `loadedAt` is when the database response was read, not when
Luma was last refreshed; use each record's `syncedAt` for index freshness.

The indexed memberships must belong to the requested person and to the key's
allowed event IDs. No other person's guest record is returned. Email addresses
are selected and returned only with `guests:email`. Internal email-based person
IDs and email display-name fallbacks are not exposed to keys without that
permission. Guest-only IDs (`guest:{lumaGuestId}`) resolve to the indexed person
within the key's event access before their other memberships are queried.
Where multiple indexed rows match the same person/event, the most recently
synced row is selected, with person ID as a stable tie-breaker.

Pages default to 10 events and accept `limit` from 1 to 500. Follow
`pagination.nextCursor` until null, preserving `personId` and `limit`. Results
are ordered by event ID. Normal person lookups use the existing `personId` and
`lumaUserIdLower` indexes; the database loads only the selected event details
and matching memberships. Unknown people and people with no accessible indexed
memberships return an empty page without revealing their existence elsewhere.

The endpoint cannot discover unindexed registrations or see Luma changes that
have not reached Guestbook's index. A removed registration can remain in history
until the existing indexing pipeline reconciles it. This API never initiates
that reconciliation or waits for Luma.

## Pagination and errors

All list endpoints return `{ data: [...], pagination: { hasMore, nextCursor } }`.
For event and guest lists, `limit` defaults to 100 and accepts integers 1–500;
person history defaults to 10 and accepts integers 1–500. Pass `nextCursor` back as
`cursor`, preserving the filters, until it is null. Events sort by event ID;
guests sort by stable Luma user ID (or `guest:{lumaGuestId}` when no user ID
exists) within an event. Guest IDs never fall back to email addresses. URL-encode cursors and event IDs.
Pagination is not a transactional snapshot: each guest page re-reads Luma, so new records or status changes during a long
export may require another pass. The email platform should deduplicate by
`personId` within the event and by email before sending.

Unknown, repeated, and malformed query parameters return 400. Other responses:
401 for invalid/expired/revoked credentials, 403 for missing permission or event
access, 404 for an unknown event, and 500/503 for unavailable database setup.
Errors return `{ error: "..." }` without database details.

## Deployment

The canonical production host is the existing `f-inc/guestbook` Vercel project.
Link the normal checkout with `vercel link --project guestbook --scope f-inc`,
then deploy with `vercel deploy --prod --scope f-inc`. The build generates the
matching Prisma client. `.vercelignore` excludes local credentials, logs, worker
state, and build output from uploads. Live Luma diagnostics also go to the
Vercel runtime logs, since the application directory is read-only there.


The migration `prisma/manual-migrations/20261027_add_integration_api_keys.sql`
creates only `integration_api_keys`. Tests do not apply migrations. Verify the target database, take a suitable schema backup, review the
SQL, and obtain explicit approval before applying it to production. Deploy the
matching generated Prisma client and application code. Existing event/person
schemas and data are unchanged. Without the new table, key administration and
integration authentication cannot operate.

Verification uses mocked database calls and never connects to the configured
database. Run `npm test` and `npm run typecheck` locally.
