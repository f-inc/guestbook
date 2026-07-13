# AGENTS.md

## Luma Debugging

- For guest-loading issues, check `.debug/luma-api.log` first. The UI and API responses include a `requestId`; search that ID in the log.
- Use `tail -f .debug/luma-api.log` while selecting events or guests, clicking `Refresh guests`, `Refresh activity`, `Refresh Luma`, or running `/api/luma/sync`.
- The log is redacted by design. Do not add logs for `LUMA_API_KEY`, authorization headers, raw invite recipient lists, or full contact datasets.
- Guest loading, trace scans, and DB sync should stay bounded and explicit: no contacts/list calls and no automatic full-calendar guest scans outside the `/api/luma/sync` job limits.
- The Luma activity index is Prisma-backed. Check `prisma/schema.prisma` before changing indexed event/person/guest activity fields.
