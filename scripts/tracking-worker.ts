import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
// A separate supervised process keeps queued work moving when no browser is open.
async function main() {
  const { runRemovalBatch } = await import("../app/api/luma/email-removal");
  const { runVerificationTick } = await import("../app/api/luma/email-verification");
  const { runTrackingBatch } = await import("../app/api/luma/tracking-queue");
  const { serverTrackingSession } = await import(
    "../app/api/luma/tracking-session"
  );
  const { prisma } = await import("../app/api/luma/db");
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    {
      try {
        await runRemovalBatch();
        await runVerificationTick();
        const token = await serverTrackingSession();
        if (!token) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        const result = await runTrackingBatch(token, crypto.randomUUID());
        if (result.checked)
          console.log(
            JSON.stringify({
              event: "tracking batch",
              checked: result.checked,
            }),
          );
      } catch (e: any) {
        console.error(
          JSON.stringify({
            event: "tracking paused or failed",
            code: e.code || "TRACKING_ERROR",
          }),
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  await prisma().$disconnect();
}
void main();
