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
