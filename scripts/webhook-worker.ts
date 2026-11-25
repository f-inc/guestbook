import {
  withDatabaseHandoff,
  disconnectDatabaseHandoff,
  handoffEnabled,
} from "../app/api/luma/database-handoff";
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { notificationClient, DatabaseNotifications, INBOX_CHANNEL } =
    await import("../app/api/luma/webhooks/notifications");
  const { claimQueuedWebhook, completeQueuedWebhook, failQueuedWebhook, nextWebhookAttempt } =
    await import("../app/api/luma/webhooks/inbox");
  const { processQueuedWebhook } = await import("../app/api/luma/webhooks/process");
  const { disconnectDatabaseClients } = await import("../app/api/luma/db");
  const lock = notificationClient();
  const destinationLock = handoffEnabled()
    ? notificationClient({
        DB_NOTIFY_URL: process.env.DB_DESTINATION_NOTIFY_URL,
        DB_NOTIFY_CA_CERT: process.env.DB_DESTINATION_NOTIFY_CA_CERT,
      })
    : undefined;
  let stopping = false;
  let busy = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolveStopped: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    resolveStopped();
  };
  lock.on("error", () => {
    process.exitCode = 1;
    stop();
  });
  lock.on("end", () => {
    if (!stopping) {
      process.exitCode = 1;
      stop();
    }
  });
  try {
    await lock.connect();
    // Rolling replacements wait for the old process to release ownership. The
    // database grants this lock without a polling loop or duplicate projections.
    await lock.query("SELECT pg_advisory_lock(821157032)");
    if (destinationLock) {
      destinationLock.on("error", () => {
        process.exitCode = 1;
        stop();
      });
      destinationLock.on("end", () => {
        if (!stopping) {
          process.exitCode = 1;
          stop();
        }
      });
      await destinationLock.connect();
      await destinationLock.query("SELECT pg_advisory_lock(821157032)");
    }
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    const wake = async () => {
      if (stopping) return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      if (timer) clearTimeout(timer);
      try {
        await withDatabaseHandoff(async () => {
          do {
            pending = false;
            let row;
            while (!stopping && (row = await claimQueuedWebhook())) {
              try {
                await processQueuedWebhook(row);
                await completeQueuedWebhook(row);
                console.log(
                  JSON.stringify({
                    event: "webhook processed",
                    type: row.webhook_type,
                    attempt: row.attempts,
                  }),
                );
              } catch (error: any) {
                const code = /^[A-Z0-9_]{1,80}$/.test(error?.code)
                  ? error.code
                  : "WEBHOOK_PROCESSING_ERROR";
                await failQueuedWebhook(row, code, error?.retryAfter);
                console.error(
                  JSON.stringify({
                    event: row.attempts >= 10 ? "webhook dead letter" : "webhook retry scheduled",
                    code,
                    attempt: row.attempts,
                  }),
                );
              }
            }
          } while (pending && !stopping);
          const next = await nextWebhookAttempt();
          if (next && !stopping)
            timer = setTimeout(() => void wake(), Math.max(250, next.getTime() - Date.now()));
        }, "index");
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
    unsubscribe = notifications.subscribe({
      ready: () => void wake(),
      disconnected: () => {},
      change: (channel) => {
        if (channel === INBOX_CHANNEL) void wake();
      },
    });
    await stopped;
    while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await destinationLock?.end().catch(() => {});
    await lock.end().catch(() => {});
    await disconnectDatabaseClients();
    await disconnectDatabaseHandoff();
  }
}

main().catch(() => {
  console.error(
    "Webhook worker could not start. Check database session access and the inbox migration.",
  );
  process.exitCode = 1;
});
