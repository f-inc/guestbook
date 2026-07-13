/// <reference types="@cloudflare/workers-types" />

type Env = {
  GUESTBOOK_APP_URL: string;
  GUESTBOOK_KEY: string;
  GUESTBOOK_SYNC_SECRET: string;
};

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncGuestbook(env));
  },

  async fetch(request: Request, env: Env) {
    if (!env.GUESTBOOK_KEY) {
      return Response.json(
        { ok: false, error: "Missing GUESTBOOK_KEY." },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
    }
    const providedKey = request.headers.get("x-guestbook-session-key") || "";
    if (!constantTimeEqual(providedKey, env.GUESTBOOK_KEY)) {
      return Response.json(
        { ok: false, error: "Unauthorized session key." },
        { status: 401, headers: { "cache-control": "private, no-store" } },
      );
    }

    return Response.json(
      {
        ok: true,
        worker: "guestbook-hourly-sync",
        target: env.GUESTBOOK_APP_URL,
        schedule: "0 * * * *",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  },
};

async function syncGuestbook(env: Env): Promise<void> {
  const response = await fetch(`${env.GUESTBOOK_APP_URL}/api/luma/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GUESTBOOK_SYNC_SECRET}`,
      "x-guestbook-session-key": env.GUESTBOOK_KEY,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Guestbook sync failed: ${response.status} ${body.slice(0, 500)}`);
  }
}

function constantTimeEqual(leftValue: string, rightValue: string): boolean {
  let difference = leftValue.length ^ rightValue.length;
  const length = Math.max(leftValue.length, rightValue.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftValue.charCodeAt(index) || 0) ^ (rightValue.charCodeAt(index) || 0);
  }
  return difference === 0;
}
