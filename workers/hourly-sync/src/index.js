export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncGuestbook(env));
  },

  async fetch(_request, env) {
    return Response.json({
      ok: true,
      worker: "guestbook-hourly-sync",
      target: env.GUESTBOOK_APP_URL,
      schedule: "0 * * * *",
    });
  },
};

async function syncGuestbook(env) {
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
