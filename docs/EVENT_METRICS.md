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

## First event to Open Campus conversion

The staff-only `GET /api/events/metrics/open-campus-funnel` reads the aggregate-only
Guestbook `POST /api/v1/analytics/open-campus-funnel`. Requests contain only the
report date range (exclusive `to`) and optional category/status/location filters;
responses contain counts and coverage, no guest identities or matching tokens.
Guestbook requires events:read plus guests:read and scopes the entire history to
the integration key before reading guests. This is an idempotent read, not a write.

The baseline is unique connected indexed person/normalized-email identities whose
first timestamped check-in in accessible history is at a non-Open Campus event.
The first-check-in Pacific date selects the cohort; filters apply to that first
event. Earlier history is retained to avoid treating returning people as new.
Later outcomes are followed through the current snapshot, beyond the selected
cohort dates. Open Campus is identified by the saved title's whole-word phrase.
Registrations require a recorded registration timestamp after the first visit.
Acceptance requires accepted/check-in state or historical approval evidence; known
approval dates must follow registration. Check-in must follow registration and
known approval at the same Open Campus event. Every stage counts each person once.

Status-only check-ins without timestamps exclude the person rather than inventing
a first-visit date. Read limits are 2,000 accessible events and 100,000 relevant
guest rows (check-ins plus Open Campus registrations); exceeding them fails closed.
A repeatable-read snapshot preserves event/guest consistency. Incomplete event
indexes make the cohort provisional: missing earlier visits can change membership,
while missing later records can change conversion. Restricted keys explicitly
limit the meaning of first visit. This is observed history, not proof of first-ever
physical attendance or causal attribution. Counts differ from repeat attendance
in the registration-to-attendance chart.

The fifth stage, received an Open Campus guest pass, is currently null and visibly
unavailable. Cross-service recipient matching is not enabled. It must not be
substituted with team counts, current team membership, or zero.

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
continues to select first-visit cohorts, with later Open Campus outcomes followed
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
