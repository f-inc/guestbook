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

The first-event Open Campus funnel uses unique indexed people and a first non-Open
Campus check-in cohort, followed through later outcomes. Keep identity processing
inside Guestbook, report coverage and chronological exclusions, and leave the
guest-pass stage unavailable until cross-service recipient matching is enabled.

Open Campus Guest Pass conversion supports explicitly authorized server-only
recipient matching: accept per-request HMAC email tokens, keep exact alias joining
inside Guestbook and return counts only. Preserve event-key scoping, chronology,
bounded payload/history reads, and no token/identity logging or persistence.

Open Campus recipient matching may fall back from email to an unambiguous normalized full name, using rotating domain-separated HMAC tokens. Preserve email priority, unique recipient/name ownership, timestamped check-ins and milestone chronology. Reject ambiguous, fuzzy and first-name-only matches; never persist identity links from this read.
