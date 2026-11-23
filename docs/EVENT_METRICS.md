# Event metrics

Staff open `/admin/event-metrics` from Admin. Access uses guest-pass management or
application review, excluding restricted guest-pass-only staff, machine clients
and preview personas.

Campus reads `GET /api/events/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`, with exclusive
`to`, 1–366 day ranges and optional exact `category`, `status`, `location` filters.
The API calls Guestbook server-to-server at `/api/v1/analytics/events` with
server-only `GUESTBOOK_API_URL` and `GUESTBOOK_API_KEY` (events:read + guests:read).
Keys and guest identities never enter the browser. All responses are private/no-store.

Guestbook returns at most 500 timed, indexed Luma events within the key's event
restrictions and selected Pacific start dates, including inactive catalog entries.
No live guest scans, index refreshes, migrations or writes run on report reads.
The event catalog, sync metadata and grouped guest counts use a repeatable-read
transaction and existing human-index routing. Incomplete/truncated/missing guest
indexes return attendance=null, never zero. Only complete indexes use zero for
missing grouped rows. Guestbook scopes the query before reading guest aggregates.

Registration/accepted predicates match Guestbook's existing cohorts. Checked-in
means a recorded timestamp or checked_in status. Repeat visits across events count
separately. Aggregate attendance totals stay unavailable when any selected event
has an incomplete index. The UI shows separately labelled indexedAttendance totals
for complete events, disclosing the exact covered-event count; per-event complete
counts remain visible. These partial totals are never presented as full-range totals. Attendance rate
uses check-ins / accepted at completed events only and requires complete held indexes.
Capacity used is per completed event: check-ins / recorded positive event capacity.
Unknown capacity is unavailable; never infer it. Missing end times stay unknown
after start. Held means scheduled end passed, not proof of attendance.

Weekly/monthly charts and category/location drilldowns share one response snapshot.
Weeks run Monday–Sunday; boundary buckets may be partial and empty buckets remain.
Dates use Pacific time. Missing starts are excluded; index coverage is not all Luma
history. Categories and locations use saved Guestbook values. The oldest successful
guest sync is displayed. Capacity here describes event seats, not campus room-hours.

Deployment order: Guestbook aggregate endpoint, Campus backend, frontend. No database
migration. Pin the actual released backend SHA in frontend release requirements
before publishing. Configure the server integration key privately.

## Event visitors to Open Campus conversion

The staff-only `GET /api/events/metrics/open-campus-funnel` reads Guestbook’s
read-only `POST /api/v1/analytics/open-campus-funnel`. The date range uses exclusive
`to`, Pacific dates and optional event category/status/location filters. Covered
ranges can include bounded private recipient tokens; responses contain only counts
and coverage. Preserve integration scopes and private/no-store staff responses.

The cohort is unique indexed person/normalized-email identities with a timestamped
check-in at any non-Open Campus event during the selected period, including people
who have attended before. Filters apply to that qualifying visit, not their first-ever
visit. Multiple qualifying visits count once. The earliest qualifying in-period visit
anchors the later Open Campus journey, including outcomes after the selected dates.

Advance registration and approval are allowed for a later Open Campus event.
Recorded Open Campus attendance after the qualifying event visit establishes
registration and acceptance even if signup/approval timestamps are missing or out
of order. The Open Campus checked-in stage requires an actual timestamped check-in
after that qualifying visit. An earlier Open Campus visit alone never qualifies.
Each stage counts each person once and uses the same membership as its drilldown.
The legacy API key `firstVisit` now represents these event visitors.

Status-only check-ins do not invent visit times or exclude other known qualifying
visits. Reads remain bounded to 2,000 accessible events and 100,000 relevant guest
rows; exceeding limits fails closed. Incomplete indexes and restricted key scopes
are disclosed; counts represent observed indexed visits, not causal attribution.

The fifth stage directly checks approved Guest Pass ownership among the nested
Open Campus checked-in cohort, using private email/full-name tokens. Confirmed
incoming pass holders count; no pass-start or issuance-order restriction applies.
It remains unavailable before September 20, 2026 or when matching cannot complete;
never substitute team counts, current membership, the separate Open Campus total,
or zero. Guestbook performs all cohort and chronological matching read-only.

## Guestbook metric drill-downs

Available IRL funnel stages link to Guestbook `/metrics` in a separate tab. The
backend uses optional server-only GUESTBOOK_PUBLIC_URL, otherwise GUESTBOOK_API_URL;
no browser link is guessed when neither is configured. Origins reject credentials,
paths and insecure non-loopback HTTP. Local preview links use a protected share.
No access keys, person IDs or emails are included in Campus drill-down links.

Links carry dates, filters, expected count and explicit complete event IDs for the
first three attendance stages. Those lists contain event records, including repeat
people across events. Cohort-stage links carry the accessible history scope and
reuse the exact unique-person evaluator used by aggregate counts. Date filtering
continues to select event-visitor cohorts, with later Open Campus outcomes followed
through the current snapshot. Missing guest-pass metrics have no link.

The list is rendered only after Guestbook session authentication, reads indexed
history without live scans or writes, and paginates 50 records at a time. Names and
profile links stay within Guestbook; they are not returned to Campus OS. Existing
read bounds and repeatable-read snapshots apply. Invalid filters and oversized reads
fail closed. Links show the current index, not an immutable historical export: when
the current count differs from the chart's expected count, the page discloses this
and asks users to refresh metrics. A new Guestbook hostname may require sign-in.

## Campus people-list view

Campus reuses the standalone metric people read through `GET /api/metrics`,
authenticated with the existing server-only Guestbook workspace key. It accepts
the same query as `/metrics`, preserves bounded database reads and pagination,
and responds with private/no-store JSON. Deploy this endpoint before the Campus
bridge/frontend. Existing standalone routes and integration-key APIs are unchanged.
### Open Campus recipient matching

POST /api/v1/analytics/open-campus accepts a bounded nonce and list of HMAC-SHA256
recipient tokens with receivedAt timestamps. It requires the existing events:read
and guests:read scopes, honors event restrictions, rejects raw email input, and
returns guestPassMatches counts plus private request-local recipientIndex/isNew
membership entries to the authenticated integration.
The integration key keys domain-separated tokens and a fresh nonce rotates them
per request. Never log, persist or return submitted tokens or recipient identities.

Matching connects exact normalized indexed email aliases to unique people inside
Guestbook. A selected Open Campus timestamped check-in must precede the recipient
milestone; newcomers have no earlier recorded event check-in. Earlier invitations and
registrations do not disqualify newcomers. Reads are capped at 1,000 recipients, 128 KiB streamed
payload, 2,000 scoped history events and 100,000 indexed relevant guest rows.
Restricted or incomplete history, ambiguous names and untimestamped visits
limit matching. No live scans, index refreshes, writes or migrations occur.

Open Campus metrics reuse getIndexedMultiEventStats in read-only mode, rather than
a separate event-record aggregation. Select only catalogActive Open Campus events
and exclude upcoming events. Counts are unique people. New overlays and recipient subsets exclude only earlier
recorded event check-ins, including earlier Open Campus visits. No cache-refresh writes
are permitted from the aggregate API.

Open Campus responses include six native workspace drilldownLinks selecting exact
event IDs, event_view=all, tab=overview and existing guest_status filters: registered,
accepted, checked_in, new_attendee_registered, new_attendee_accepted and new_attendee_checked_in.
The chart and native table use unique-person totals. Existing /metrics IRL journey
links remain unchanged. Recipient New splits use the same attendance-history definition.

Private Open Campus recipient membership returns one request-local index per matched
Guestbook identity, preserving total/New subset counts without exporting Guestbook
person IDs, names, raw emails or HMAC tokens. Campus OS uses those indices only on
the server to render its separately authorized native recipient cohort. The normal
metrics response exposed by Campus OS strips all membership indices.

Recipient matching falls back to normalized full names when email has no qualifying
check-in. Names use NFKC, case folding and collapsed whitespace, require at least
two words and exclude email-shaped values. Only request-scoped domain-separated
HMAC name tokens cross services. A fallback must identify exactly one qualifying
Guestbook identity and be unique among Campus OS recipients; ambiguous matches
are excluded. Email matches take priority; no fuzzy or first-name-only matching,
identity merging, persistence or relaxed event-date/milestone rules is introduced.

IRL funnel Guest Pass conversion accepts the same bounded private recipient tokens as Open Campus metrics. Match only valid, chronological check-ins inside the first-non-Open-Campus-visit cohort after all nested stages and filters; never reuse the independent Open Campus total. History before September 20, 2026 and missing matching stay unavailable. Aggregate responses never export private memberships or tokens.

IRL Guest Pass means approved pass ownership among the already-narrowed checked-in people, including confirmed incoming recipients. Do not add campus-start or pass-issuance timing restrictions at this final stage. Keep earlier funnel stages unchanged.

Metrics snapshots run as database-enforced read-only repeatable-read transactions with bounded waits. Preserve human identity routing, but bypass the human projection writer advisory lock for these reads so an ongoing sync cannot block reports. Keep writer locking unchanged.
