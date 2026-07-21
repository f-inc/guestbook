# Guestbook

Guestbook is a compact event-ops console for Luma-backed communities. It gives teams one place to browse events, review guests, track attendance history, and build invite audiences without pulling an entire calendar or contacts database into the browser.

## What It Does

- Loads Luma events and guests through server-side API routes.
- Shows event lists, guest status, registration details, social/profile fields, and activity history.
- Supports approval, waitlist, decline, and invite workflows where Luma exposes those actions.
- Keeps a Prisma-backed activity index for faster guest lookup, profile traces, and sync observability.
- Provides bounded sync controls so large calendars can be refreshed deliberately.

## Stack

- Next.js App Router
- TypeScript
- React
- Tailwind CSS
- Prisma
- PostgreSQL
- Luma public API

## Quick Start

Create your local env file:

```bash
cp .env.local.example .env.local
```

Set the required values:

```bash
LUMA_API_KEY=your_luma_calendar_api_key
DB_URL=your_postgres_connection_string
GUESTBOOK_KEY=replace_with_private_guestbook_key
GUESTBOOK_SYNC_SECRET=replace_with_random_sync_secret
```

Install dependencies, prepare Prisma, and start the app:

```bash
npm run safe:install
npm run db:generate
npm run db:push
npx prisma db execute --file prisma/manual-migrations/20260721_add_automatic_archetype_tags.sql --schema prisma/schema.prisma
npm run dev
```

Open `http://localhost:3000`.

## Syncing

The `/api/luma/sync` endpoint ingests event and guest activity into the local database. Run it manually with:

```bash
curl -X POST http://localhost:3000/api/luma/sync \
  -H "x-guestbook-session-key: $GUESTBOOK_KEY" \
  -H "Authorization: Bearer $GUESTBOOK_SYNC_SECRET"
```

The hourly Worker uses the same key for scheduled syncs and its status URL. Store `GUESTBOOK_KEY` and `GUESTBOOK_SYNC_SECRET` as Wrangler secrets before deploying it.

The sync job is intentionally capped by defaults in `.env.local.example`. Raise those limits only when you explicitly want a larger backfill.

### Automatic Tags

Every completed `/api/luma/sync` run classifies people from the local PostgreSQL activity index. It does not make additional Luma requests. A full cron sync recomputes the complete index; `Sync event` reevaluates affected people and automatically falls back to a full run when the latest public-event window changes.

The managed archetypes are `🚀 Superpower User`, `⚡ Power User`, `🎪 Festival Dweller`, `👻 Flaker`, and `💀 Superflaker`. `🎪 Festival Dweller` means the person's most recent known checked-in event has `festival` in its title; newer registrations and no-shows do not affect it. Automatic assignments are stored separately from manual tags and materialized into `luma_people.tags` for fast guest-table reads and filtering.

Preview a full classification without writing assignments:

```bash
curl -X POST http://localhost:3000/api/tags/auto \
  -H "x-guestbook-session-key: $GUESTBOOK_KEY" \
  -H "Content-Type: application/json" \
  --data '{"scope":"all","dryRun":true}'
```

Only successfully synced, non-truncated events are eligible. Public-event streaks use Luma's `visibility = public`; ongoing events wait until their recorded end time, or the configured settle interval when no end time is available.

## Safety Notes

Guestbook keeps Luma credentials server-side, avoids contacts/list endpoints, and writes redacted endpoint logs to `.debug/luma-api.log`. Local env files, logs, build output, and dependencies are ignored by Git.

Automatic tags write only to Guestbook's PostgreSQL database. They never update Luma guest records.

Run the test suite with:

```bash
npm test
```
