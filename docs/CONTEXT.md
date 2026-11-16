# Guestbook: what this repo is and why

Audience: a new teammate, an operator, or a coding agent who has to touch this repo.
Part 1 is plain language. Part 2 (technical appendix) has entrypoints, data, deploy target and test commands.
Read out of this repo on 2026-11-13. Unconfirmed items are listed at the end.

**Related app docs:** [os-v2](https://github.com/f-inc/os-v2/blob/main/docs/CONTEXT.md) · [os-web](https://github.com/f-inc/os-web/blob/main/docs/CONTEXT.md) · [Odin](https://github.com/f-inc/Odin/blob/main/docs/CONTEXT.md) · [inbox0](https://github.com/f-inc/inbox0/blob/main/docs/CONTEXT.md) · [easyraises-a42367c8](https://github.com/f-inc/easyraises-a42367c8/blob/main/docs/CONTEXT.md) (index of all six lives in the F.inc #dev notes).

## Part 1: the plain-language version

### What it is in one paragraph

Guestbook is an event-ops console for Luma-backed communities. Luma is where events are published and people register; Guestbook pulls that data in so the team can see every event and guest in one place, check people in, approve or decline, look at someone's attendance history, and build invite audiences without exporting spreadsheets. It keeps its own indexed copy of Luma data so lookups are fast, and it exposes a small, documented API for other tools.

### Why it exists and who uses it

Running community events straight out of Luma works until you need to answer questions like "has this person been to three events, and who invited them?" or "who should we invite to the next dinner?". Guestbook exists to answer those, to run the door at events, and to keep a durable record of guest history and invite tracking. It also bridges Campus form submissions into the event workflow.

Users: the community/events team (event and guest review, check-in, audience building), and adjacent internal tools that consume its API with a key.

### What data it owns

Its own PostgreSQL database, modelled with Prisma:

- `LumaEvent`, `LumaPerson`, `LumaEventGuest` - the mirrored event and guest index.
- Tagging: `GuestTag`, `SuperTag`, `SuperTagRule`, `ManualTagMutation`, `AutomaticTagAssignment`, `AutomaticTagState`.
- Sync and reliability: `LumaSyncRun`, `LumaEventSyncState`, `LumaWebhookDelivery`, `LumaTrackingState`, `LumaCalendarOptOut`.
- Invites: `LumaInviteTracking`, `LumaInviteAttempt`.
- Email hygiene: `EmailAddress`, `EmailVerificationCheck`, `EmailVerificationRun`, `EmailVerificationBatch`, `EmailRemovalJob`, `EmailRemovalItem`, `EmailInactive`.
- `IntegrationApiKey` for the public API.

**Luma remains the upstream source of truth for events and registrations.** Guestbook's rows are a mirror plus local annotations (tags, invite history, email-verification state). Anything Campus owns - accounts, teams, applications - is read over the Campus API, never copied in as authority.

### Current status: live

Served at `guestbook.f.inc` on an existing Founders, Inc. Vercel project, with a public API at `/api/v1` and generated docs at `/api-docs`. Two background workers live in `workers/`: `hourly-sync` and `campus-calendar`.

### Non-obvious constraints a new contributor will trip on

1. **The database is a mirror, and the mirror can be wrong.** Webhooks update one guest at a time; a full `/api/luma/sync` is a bounded recovery scan, not a routine action. If you "fix" a guest locally you will be overwritten by the next sync - change it in Luma, or accept it as local annotation only.
2. **Sync is deliberately bounded.** Large calendars are refreshed in bounded batches so the app does not pull an entire calendar into a request. Do not replace bounded sync with a loop that fetches everything.
3. **There is no single migration command for everything.** `prisma db push` applies the Prisma schema; the hand-written files in `prisma/manual-migrations/` must be executed one by one (`prisma db execute --file ...`). Skipping them leaves a functioning-looking app with missing columns or state tables.
4. **Credentials come in numbered pairs.** `LUMA_API_KEY`, `LUMA_API_KEY_2`, ... and `LUMA_SESSION_TOKEN`, `_2`, ... are merged; calendar webhooks each have their own signing secret (`LUMA_WEBHOOK_SECRET`, `_2`, ...). Events visible through an API key win over session-only access.
5. **The Campus bridge is the fragile part.** `CAMPUS_API_URL` must be `https://api.f.inc` (an old Railway URL is not a valid override). Server calls need the scoped Campus bearer key plus `API_FIREWALL_BYPASS_KEY` sent as `x-finc-internal` to clear the Campus Vercel firewall challenge. Neither credential goes to the browser, and the header must stay limited to the configured Campus origin.
6. **Edge rules gate the public API.** The `guestbook.f.inc` Cloudflare rule must allow `/api/v1` through, or integrations get an HTML challenge instead of JSON.
7. **Install through Socket.** `npm run safe:install` is the sanctioned install path (Socket security scanning); `security:scan` runs the CI scan.
8. **Local port is 3030** (`next dev --port 3030`).

## Part 2: technical appendix

**Entrypoints**
- `app/` - Next.js App Router: `app/events`, `app/admin`, `app/api/luma/*`, `app/api/campus/form-submissions`, `app/api/campus/company-icon`, `app/api/v1/*` (public API), `app/api-docs`.
- `prisma/schema.prisma` (+ `prisma/manual-migrations/`).
- `workers/hourly-sync`, `workers/campus-calendar` - Cloudflare-style background workers; `scripts/tracking-worker.ts` for the invite-tracking loop.
- `docs/integration-api.md` - the public API contract (the `/api-docs` page is generated from it).

**Tables**
See the model list in Part 1; `prisma/schema.prisma` is authoritative.

**Roles and auth**
`GUESTBOOK_KEY` gates the app itself; `GUESTBOOK_SYNC_SECRET` authorises sync; `LUMA_WEBHOOK_SECRET*` verifies webhooks; `IntegrationApiKey` rows (managed at `/admin`) authorise `/api/v1`. Campus calls use a scoped bearer key held server-side only.

**Deploy target**
Existing Founders, Inc. Vercel project serving `guestbook.f.inc` (Next.js). Persistent Node deployment for the tracking worker; the hourly sync runs as a worker/scheduled job.

**Test and check commands**
```bash
npm run dev        # http://localhost:3030
npm test           # tsx --test over app/api/luma, app/api/campus, app/api/v1 suites
npm run typecheck  # next typegen && tsc --noEmit
npm run build      # prisma generate && next build
```

**Where the rules live**
`README.md` (long, detailed, operational), `AGENTS.md`, `docs/integration-api.md`, `prisma/schema.prisma`.

## What I could not verify from this repo

- The exact Vercel project the domain is attached to, its environment variables, and whether stale Railway overrides still exist in production.
- Whether the Campus form-submissions integration is currently healthy. The README records an unresolved investigation (404s and Cloudflare challenges) and asks for verification from the deployed runtime; that needs a live check.
- Which Luma calendars are currently connected, and how many API keys or session tokens production holds.
