import { requireGuestbookKey } from "../../session-auth";
import { databaseNotifications, CHANGE_CHANNEL, notificationDatabaseUrl } from "../webhooks/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    requireGuestbookKey(request);
    notificationDatabaseUrl();
  } catch (error: any) {
    return Response.json({ error: "Live updates unavailable." }, { status: error?.status || 503 });
  }
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval>;
      let lifetime: ReturnType<typeof setTimeout>;
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        request.signal.removeEventListener("abort", cleanup);
        // cancel() may run after the stream has already closed internally.
        try { controller.close(); } catch {}
      };
      unsubscribe = databaseNotifications.subscribe({
        // A reconnect always reloads indexed state, recovering notifications
        // missed while the browser/server was disconnected. No Luma scans.
        ready: () => send("ready", {}),
        disconnected: () => send("unavailable", {}),
        change: (channel, payload) => {
          if (channel !== CHANGE_CHANNEL) return;
          try {
            const data = JSON.parse(payload);
            if (data.eventId === null || (typeof data.eventId === "string" && /^[a-z0-9_-]{1,160}$/i.test(data.eventId))) {
              send("change", { eventId: data.eventId });
            }
          } catch { /* Ignore malformed notifications; never forward raw payloads. */ }
        },
      });
      // Transport keepalives never query a database or upstream API.
      heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); }, 20_000);
      lifetime = setTimeout(cleanup, 240_000);
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) cleanup();
    },
    cancel() { cleanup(); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "private, no-store, no-transform", "x-accel-buffering": "no" } });
}
