# AGENTS.md

## Database Safety

- The local application may connect to the production database. Running on localhost does not mean the database is isolated. Treat the configured database as production unless verified otherwise.
- Before direct database edits, migrations, schema pushes, backfills, or write-capable tests, verify the target database and the scope of the changes without exposing connection strings or credentials.
- Be extremely careful with production or unverified databases. Prefer read-only inspection and mocks or an explicitly isolated test database. Do not assume test writes are safe merely because they are intended to roll back.
- Prepare and review migrations locally before applying them. Obtain explicit authorization for applying changes to a production or unverified database; a request to implement a feature is not by itself authorization to modify production data or schema. For authorized changes, use bounded operations and an appropriate backup or recovery plan.

## Luma Debugging

- For guest-loading issues, check `.debug/luma-api.log` first. The UI and API responses include a `requestId`; search that ID in the log.
- Use `tail -f .debug/luma-api.log` while selecting events or guests, clicking `Refresh guests`, `Refresh activity`, `Refresh Luma`, or running `/api/luma/sync`.
- The log is redacted by design. Do not add logs for `LUMA_API_KEY`, authorization headers, raw invite recipient lists, or full contact datasets.
- Guest loading, trace scans, and DB sync should stay bounded and explicit: no contacts/list calls and no automatic full-calendar guest scans outside the `/api/luma/sync` job limits.
- The Luma activity index is Prisma-backed. Check `prisma/schema.prisma` before changing indexed event/person/guest activity fields.

## Local development ports

- The development server for **guestbook** uses **http://localhost:3030**.
- Run `npm run dev` in the normal checkout; its development script sets port **3030** explicitly. Do not use localhost:3000 or silently increment ports.
- Reuse an existing server for this checkout. If the assigned port is occupied by an unrelated process, inspect ownership rather than stopping another project's server.
- Port changes must update the development script, README, environment examples, and local integration/callback URLs together. Keep real credentials in ignored local environment files; never commit them or change production URLs for local development.

On Haseab's BB machine, the shared registry is `~/.bb/dev-ports.json` and
`~/.bb/bin/project-dev guestbook` uses the same assignment. These personal
files are optional; collaborators can use the repository commands above.

### Event metrics

Staff Event metrics uses Guestbook’s read-only indexed aggregate API, not the campus
calendar or live guest scans. Preserve scoped event access, complete-index disclosures,
Pacific dates, filter-bound drilldowns and private/no-store responses. Missing counts
and capacities are unavailable. Deploy Guestbook and backend first. See docs/EVENT_METRICS.md.

The IRL Open Campus funnel follows unique non-Open Campus event attendees in the selected period, including returning visitors, through later Open Campus attendance. Use private recipient matching for approved Guest Pass ownership within that exact cohort. Preserve indexed coverage and historical cutoff disclosures.

Open Campus Guest Pass conversion supports explicitly authorized server-only
recipient matching: accept per-request HMAC email tokens, keep exact alias joining
inside Guestbook and return counts only. Preserve event-key scoping, chronology,
bounded payload/history reads, and no token/identity logging or persistence.

Open Campus recipient matching may fall back from email to an unambiguous normalized full name, using rotating domain-separated HMAC tokens. Preserve email priority, unique recipient/name ownership, timestamped check-ins and milestone chronology. Reject ambiguous, fuzzy and first-name-only matches; never persist identity links from this read.

IRL funnel Guest Pass conversion accepts the same bounded private recipient tokens as Open Campus metrics. Match only valid, chronological check-ins inside the in-period non-Open-Campus attendee cohort after all nested stages and filters; never reuse the independent Open Campus total. History before September 20, 2026 and missing matching stay unavailable. Aggregate responses never export private memberships or tokens.

IRL Guest Pass means approved pass ownership among the already-narrowed checked-in people, including confirmed incoming recipients. Do not add campus-start or pass-issuance timing restrictions at this final stage. Keep earlier funnel stages unchanged.

IRL event-visitor cohort includes every unique non-Open Campus attendee in the selected period, including returning visitors. Filters apply to the qualifying visit. Do not require first-ever visits or signup after the visit: allow advance registration for later Open Campus events. The actual later Open Campus check-in is decisive. Legacy firstVisit fields represent event visitors; keep chart, API and drilldowns aligned.

Open Campus New overlays and recipient subsets mean no earlier recorded event check-in, not no earlier invitation or registration. Preserve attendance-based native Guestbook drilldowns.
