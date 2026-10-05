import { runRemovalBatch } from "./email-removal";
import { runVerificationTick } from "./email-verification";
import { runTrackingBatch } from "./tracking-queue";
import { serverTrackingSession } from "./tracking-session";
const stateKey = "__guestbookTrackingBackground";
// For long-running Node deployments (e.g. Railway). Serverless deployments should
// use the standalone supervised worker instead of relying on an in-process timer.
export function startTrackingBackground() {
  if (globalThis[stateKey]) return;
  const state = { busy: false, lastError: "" };
  globalThis[stateKey] = state;
  const tick = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      await runRemovalBatch();
      await runVerificationTick();
      const token = await serverTrackingSession();
      if (!token) return;
      await runTrackingBatch(token, crypto.randomUUID());
      state.lastError = "";
    } catch (error: any) {
      const code = error.code || "TRACKING_ERROR";
      if (state.lastError !== code)
        console.warn(`[invitation tracking] ${code}`);
      state.lastError = code;
    } finally {
      state.busy = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 30_000);
  timer.unref();
}

// Removals can run without enabling unrelated tracking/verification workers.
export function startRemovalBackground() {
  const key = "__guestbookRemovalBackground";
  if (globalThis[key]) return;
  const state = { busy: false };
  globalThis[key] = state;
  const timer = setInterval(async () => {
    if (state.busy) return;
    state.busy = true;
    try { await runRemovalBatch(); }
    catch { console.warn("[email removal] Worker paused; saved claims will be recovered."); }
    finally { state.busy = false; }
  }, 10000);
  timer.unref();
}
