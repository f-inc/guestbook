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
GUESTBOOK_SYNC_SECRET=replace_with_random_sync_secret
```

Install dependencies, prepare Prisma, and start the app:

```bash
npm run safe:install
npm run db:generate
npm run db:push
npm run dev
```

Open `http://localhost:3000`.

## Syncing

The `/api/luma/sync` endpoint ingests event and guest activity into the local database. Run it manually with:

```bash
curl -X POST http://localhost:3000/api/luma/sync \
  -H "Authorization: Bearer $GUESTBOOK_SYNC_SECRET"
```

The sync job is intentionally capped by defaults in `.env.local.example`. Raise those limits only when you explicitly want a larger backfill.

## Safety Notes

Guestbook keeps Luma credentials server-side, avoids contacts/list endpoints, and writes redacted endpoint logs to `.debug/luma-api.log`. Local env files, logs, build output, and dependencies are ignored by Git.

Run the test suite with:

```bash
npm test
```
