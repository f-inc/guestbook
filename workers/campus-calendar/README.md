# Calendar webhook sync

A Cloudflare Worker receives signed Luma event webhooks and creates or updates matching events in a configured Google Calendar. It does not use the application database, guest APIs, contact lists, or a cron.

## Private configuration

Commit the source, tests, this README, and the placeholder configuration files. Keep these files out of Git:

- `wrangler.local.jsonc`: actual Worker name, Cloudflare account ID, source/destination calendar IDs, and stable sync ownership marker.
- `.local/authorization.json`: the Google account email used for one-time OAuth setup.
- `.local/`: OAuth credentials, webhook signing secret, deployment notes, and verification records.
- `.dev.vars*` and `.wrangler/`: local runtime secrets and tooling state.

The directory's `.gitignore` excludes all of these paths. Credentials used by the deployed Worker are stored separately as Cloudflare secrets.

For a new deployment, copy `wrangler.example.jsonc` to `wrangler.local.jsonc` and replace every `REPLACE_WITH_…` value. Keep the local file as plain JSON (without comments), since the OAuth setup script also reads it. Copy `authorization.example.json` to `.local/authorization.json` and set the login hint to the intended Google account. Restrict local file permissions to the current user.

`SYNC_OWNER` labels calendar entries managed by this integration. Keep its existing value when upgrading a deployment so existing entries remain recognizable. It is independent of the Worker name.

## Behavior

- Receive `event.created`, `event.updated`, and `event.canceled` at `/webhooks/luma`.
- Validate the raw-body HMAC signature and a five-minute timestamp window; reject oversized requests and other source calendars.
- Queue each event durably, serialize its writes, acknowledge duplicate deliveries, reject older delivery timestamps, and retry failed Google operations with exponential backoff up to one hour between attempts.
- Copy public titles, start/end times and timezone, public addresses, and the registration URL. Private/member-only events, guest-only addresses, meeting links, descriptions, and attendees are excluded because the destination may be publicly visible.
- Use stable Google event IDs to prevent duplicate inserts after interrupted jobs. Adopt existing manual entries only when they contain the exact Luma URL; ambiguous matches stop processing for review. Entries without a Luma URL are not automatically matched by title.
- Patch only fields managed by this integration, preserving existing attendees and reminders. New events have no reminders or attendees. API writes use `sendUpdates=none`.
- Cancel only copies owned by this integration. Cancellation is final; a later non-cancel webhook does not restore the event. An operator must reset the event's Durable Object if intentionally restoring it.
- The delivery timestamp is not an event revision number. An extremely delayed first delivery with a newer send timestamp can overwrite details with an older snapshot.
- Sync applies to events created on the configured source calendar. Syndicated/external events and historical backfill are not enabled. Initial import needs a separate, bounded preview and execution.

## Google authorization and deployment

1. Enable Google Calendar API in the intended Google Cloud project.
2. Create a dedicated Desktop OAuth client and save its JSON in `.local`. Check the project's OAuth audience: use Internal for the relevant organization, or a properly published app. External apps in Testing can issue refresh tokens that expire after seven days.
3. Run `node workers/campus-calendar/authorize.mjs /absolute/path/client.json`. The script reads the destination ID from `wrangler.local.jsonc` and the account hint from `.local/authorization.json`. Confirm the intended account on Google's consent screen and approve the event scope. The local loopback callback uses state and PKCE; its credential is saved with mode 0600 in `.local/google-oauth.json` and is never printed.
4. Authenticate Wrangler to the intended Cloudflare account, then deploy from the repository root:

   ```sh
   npx wrangler deploy --config workers/campus-calendar/wrangler.local.jsonc
   npx wrangler secret put GOOGLE_OAUTH_CREDENTIALS --config workers/campus-calendar/wrangler.local.jsonc < workers/campus-calendar/.local/google-oauth.json
   ```

   Alternatively use `GOOGLE_SERVICE_ACCOUNT` containing the service-account JSON. A calendar owner must share the destination with that service account as an editor. Do not configure both credential types. Never commit either credential JSON.
5. In the source Luma calendar, Settings → Developer → Webhooks, create a webhook for the three event actions. Use the deployed Worker's URL followed by `/webhooks/luma`. Store its generated signing secret as `LUMA_WEBHOOK_SECRET` using Wrangler's secret input or the Cloudflare Secret UI. Keep the endpoint unconfigured/503 until its secret is installed; Luma retries failures.
6. Verify `/health`, a signed webhook delivery, and the resulting Google event before declaring the automation live. Use an approved event; do not alter production source events just to test delivery.

OAuth's `calendar.events` permission covers events in calendars the authorizing account can access. The code fixes its write destination to the configured calendar, but the credential itself is not restricted to that calendar. A service account shared only onto the destination provides a narrower grant when a calendar owner can arrange it.

## Validation and operation

```sh
npx tsx --test workers/campus-calendar/src/index.test.ts
npx tsc --noEmit --skipLibCheck --strict --target es2022 --module esnext --moduleResolution bundler workers/campus-calendar/src/index.ts
npx wrangler deploy --config workers/campus-calendar/wrangler.local.jsonc --dry-run
```

These checks use mocks and do not write to any live database or calendar. Application log messages contain event IDs, outcome, and retry counts; Cloudflare may additionally collect invocation metadata. Monitor `calendar_sync_failed` for credential failures and ambiguous matches. Luma's delivery view reports durable acceptance (202), not completion of the Google write; confirm Cloudflare's `calendar_sync` result.

To pause, pause the Luma webhook. Already queued jobs can still run; remove the Google credential or disable the Worker to stop those too. Revoke OAuth consent/delete the dedicated client to permanently remove Google access. Do not delete Durable Object storage casually: it contains cancellation and deduplication state.

Keep deployment-specific URLs, account details, and verification notes in the ignored `.local/deployment-notes.md` file.
