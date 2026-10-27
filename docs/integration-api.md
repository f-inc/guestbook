# Guestbook integration API (v1)

Server-to-server base URL: `https://guestbook-production-e5fe.up.railway.app/api/v1`.

Use `https://guestbook.f.inc/admin` for key management. The custom domain currently
presents Cloudflare browser challenges to command-line/server requests. The
Railway service address reaches the same application and enforces the same API
keys and permissions, without requiring a browser challenge. Until a dedicated
Cloudflare API rule is configured, use the Railway address for integrations.

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
| `guests:read` | Read event guest IDs, names, statuses, and timestamps |
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
curl 'https://guestbook-production-e5fe.up.railway.app/api/v1/events?limit=100' \
  -H "Authorization: Bearer $GUESTBOOK_API_KEY"

curl 'https://guestbook-production-e5fe.up.railway.app/api/v1/events/evt-example/guests?checked_in=true' \
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

## Pagination and errors

Both endpoints return `{ data: [...], pagination: { hasMore, nextCursor } }`.
`limit` defaults to 100 and accepts integers 1–500. Pass `nextCursor` back as
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

The migration `prisma/manual-migrations/20261027_add_integration_api_keys.sql`
creates only `integration_api_keys`. Tests do not apply migrations. Verify the target database, take a suitable schema backup, review the
SQL, and obtain explicit approval before applying it to production. Deploy the
matching generated Prisma client and application code. Existing event/person
schemas and data are unchanged. Without the new table, key administration and
integration authentication cannot operate.

Verification uses mocked database calls and never connects to the configured
database. Run `npm test` and `npm run typecheck` locally.
