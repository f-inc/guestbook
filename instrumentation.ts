export async function register() {
  // Railway owns the durable background jobs; request-scoped Vercel functions
  // must not start another set of in-process worker timers.
  if (process.env.VERCEL === "1") return;

  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.EMAIL_REMOVAL_ENABLED === "true" && process.env.LUMA_TRACKING_WORKER_ENABLED !== "true") {
    const { startRemovalBackground } = await import("./app/api/luma/tracking-background");
    startRemovalBackground();
  }
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.LUMA_TRACKING_WORKER_ENABLED === "true"
  ) {
    const { startTrackingBackground } = await import(
      "./app/api/luma/tracking-background"
    );
    startTrackingBackground();
  }
}
