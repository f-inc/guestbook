import { cioRuntimeMode } from "./cio-projection";
import { runCioProjectionBatch, seedCioQueue } from "./cio-sync";
import { reconcileLumaSources } from "./cio-source";

type Phase = { failed?: boolean | number; failures?: number; [key: string]: unknown };
type Jobs = { delivery: () => Promise<Phase>; backfill: () => Promise<Phase>; source: () => Promise<Phase> };

// A broken Luma credential or backfill cursor must not prevent delivery of
// already queued updates. Deliver first, then run independent bounded jobs.
export async function runCioScheduledSync(
  env: Record<string, string | undefined> = process.env,
  jobs: Jobs = {
    delivery: () => runCioProjectionBatch({ budgetMs: 15_000 }),
    backfill: () => seedCioQueue(),
    source: () => reconcileLumaSources({ budgetMs: 15_000 }),
  },
) {
  const mode = cioRuntimeMode(env);
  if (mode === "disabled") return { ok: true, mode };
  const run = async (name: keyof Jobs): Promise<Phase> => {
    try { return await jobs[name](); }
    catch { return { failed: true, error: `${name}_failed` }; }
  };
  const delivery = mode === "send" ? await run("delivery") : { mode };
  const backfill = env.CIO_SYNC_BACKFILL_ENABLED === "true" ? await run("backfill") : { enabled: false };
  const source = env.CIO_SYNC_SOURCE_ENABLED === "true" ? await run("source") : { enabled: false };
  return { ok: ![delivery, backfill, source].some(r => r.failed || Number(r.failures || 0) > 0), mode, delivery, backfill, source };
}
