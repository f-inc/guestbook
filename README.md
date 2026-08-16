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
# Optional: add LUMA_API_KEY_2, LUMA_API_KEY_3, ... to aggregate managed events
LUMA_SESSION_TOKEN=your_luma_auth_session_cookie_value
# Optional: add LUMA_SESSION_TOKEN_2, LUMA_SESSION_TOKEN_3, ... as well
DB_URL=your_postgres_connection_string
GUESTBOOK_KEY=replace_with_private_guestbook_key
GUESTBOOK_SYNC_SECRET=replace_with_random_sync_secret
```

Guestbook merges and deduplicates managed events from every configured API key and signed-in session token. API-key access is preferred when both credential types can access the same event; session-only events use Luma's bounded signed-in manager endpoints for event details and guest loading.

Install dependencies, prepare Prisma, and start the app:

```bash
npm run safe:install
npm run db:generate
npm run db:push
npx prisma db execute --file prisma/manual-migrations/20260721_add_automatic_archetype_tags.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/manual-migrations/20260723_add_event_catalog_state.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/manual-migrations/20260731_add_event_feedback_stats.sql --schema prisma/schema.prisma
npm run dev
```

Open `http://localhost:3000`.

## Data Refresh

Guestbook refreshes the lightweight Luma event catalog on app load and when the browser tab becomes active. For the selected event, it compares Luma's approved, pending, waitlist, invited, declined, and checked-in counts with the local snapshot before fetching guests.

The former hourly full-sync Worker is archived. The `/api/luma/sync` endpoint remains available as a deliberate recovery or backfill command:

```bash
curl -X POST http://localhost:3000/api/luma/sync \
  -H "x-guestbook-key: $GUESTBOOK_KEY" \
  -H "Authorization: Bearer $GUESTBOOK_SYNC_SECRET"
```

The recovery job is intentionally capped by defaults in `.env.local.example`. Raise those limits only when you explicitly want a larger backfill.

### Automatic Tags

Every completed `/api/luma/sync` recovery run classifies people from the local PostgreSQL activity index. It does not make additional Luma requests. `Sync event` reevaluates affected people and automatically falls back to a full run when the latest public-event window changes.

The managed archetypes are `🚀 Superpower User`, `⚡ Power User`, `🎪 Festival Dweller`, `👻 Flaker`, and `💀 Superflaker`. `🎪 Festival Dweller` means the person's most recent known checked-in event has `festival` in its title; newer registrations and no-shows do not affect it. Automatic assignments are stored separately from manual tags and materialized into `luma_people.tags` for fast guest-table reads and filtering.

Preview a full classification without writing assignments:

```bash
curl -X POST http://localhost:3000/api/tags/auto \
  -H "x-guestbook-key: $GUESTBOOK_KEY" \
  -H "Content-Type: application/json" \
  --data '{"scope":"all","dryRun":true}'
```

Only successfully synced, non-truncated events are eligible. Public-event streaks use Luma's `visibility = public`; ongoing events wait until their recorded end time, or the configured settle interval when no end time is available.

## Safety Notes

Guestbook keeps Luma credentials server-side, avoids contacts/list endpoints, and writes redacted endpoint logs to `.debug/luma-api.log`. Local env files, logs, build output, and dependencies are ignored by Git.

Automatic tags write only to Guestbook's PostgreSQL database. They never update Luma guest records.

Event feedback is read from Luma only when a saved manager session token is available or the Feedback tab is opened. Multi-event feedback uses one Guestbook request with bounded upstream concurrency. The defaults allow up to 50 selected events, three concurrent Luma reads, and 1,000 responses per event; configure `LUMA_FEEDBACK_MAX_EVENTS`, `LUMA_FEEDBACK_CONCURRENCY`, and `LUMA_FEEDBACK_MAX_RESPONSES` to lower those limits.

Run the test suite with:

```bash
npm test
```
