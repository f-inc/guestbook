/// <reference types="@cloudflare/workers-types" />

type Env = {
  GUESTBOOK_APP_URL: string;
  GUESTBOOK_SYNC_SECRET: string;
};

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncGuestbook(env));
  },

  async fetch(_request: Request, env: Env) {
    return Response.json({
      ok: true,
      worker: "guestbook-hourly-sync",
      target: env.GUESTBOOK_APP_URL,
      schedule: "0 * * * *",
    });
  },
};

async function syncGuestbook(env: Env): Promise<void> {
  const response = await fetch(`${env.GUESTBOOK_APP_URL}/api/luma/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GUESTBOOK_SYNC_SECRET}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Guestbook sync failed: ${response.status} ${body.slice(0, 500)}`);
  }
}
