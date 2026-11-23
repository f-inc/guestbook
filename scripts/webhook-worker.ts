import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { notificationClient, DatabaseNotifications, INBOX_CHANNEL } = await import("../app/api/luma/webhooks/notifications");
  const { claimQueuedWebhook, completeQueuedWebhook, failQueuedWebhook, nextWebhookAttempt } = await import("../app/api/luma/webhooks/inbox");
  const { processQueuedWebhook } = await import("../app/api/luma/webhooks/process");
  const { prisma, sourcePrisma } = await import("../app/api/luma/db");
  const lock = notificationClient();
  let stopping = false;
  let busy = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolveStopped: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    resolveStopped();
  };
  lock.on("error", () => { process.exitCode = 1; stop(); });
  lock.on("end", () => { if (!stopping) { process.exitCode = 1; stop(); } });
  await lock.connect();
  const result = await lock.query("SELECT pg_try_advisory_lock(821157032) AS owned");
  if (!result.rows[0].owned) {
    await lock.end();
    throw new Error("Another webhook worker owns this database. Run one supervised worker.");
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const wake = async () => {
    if (stopping) return;
    if (busy) { pending = true; return; }
    busy = true;
    if (timer) clearTimeout(timer);
    try {
      do {
        pending = false;
        let row;
        while (!stopping && (row = await claimQueuedWebhook())) {
          try {
            await processQueuedWebhook(row);
            await completeQueuedWebhook(row);
            console.log(JSON.stringify({ event: "webhook processed", type: row.webhook_type, attempt: row.attempts }));
          } catch (error: any) {
            const code = /^[A-Z0-9_]{1,80}$/.test(error?.code) ? error.code : "WEBHOOK_PROCESSING_ERROR";
            await failQueuedWebhook(row, code, error?.retryAfter);
            console.error(JSON.stringify({ event: row.attempts >= 10 ? "webhook dead letter" : "webhook retry scheduled", code, attempt: row.attempts }));
          }
        }
      } while (pending && !stopping);
      const next = await nextWebhookAttempt();
      if (next && !stopping) timer = setTimeout(() => void wake(), Math.max(250, next.getTime() - Date.now()));
    } catch {
      // Retry a failed database operation, not a recurring upstream scan.
      console.error(JSON.stringify({ event: "webhook worker database unavailable" }));
      if (!stopping) timer = setTimeout(() => void wake(), 10_000);
    } finally {
      busy = false;
      if (pending && !stopping) void wake();
    }
  };
  const notifications = new DatabaseNotifications();
  unsubscribe = notifications.subscribe({ ready: () => void wake(), disconnected: () => {},
    change: (channel) => { if (channel === INBOX_CHANNEL) void wake(); } });
  await stopped;
  while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
  await lock.end().catch(() => {});
  await Promise.all([prisma().$disconnect(), sourcePrisma().$disconnect()]);
}

main().catch(() => { console.error("Webhook worker could not start. Check database session access and the inbox migration."); process.exitCode = 1; });
