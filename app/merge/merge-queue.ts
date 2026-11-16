export type MergeJobStatus = "waiting" | "queued" | "saving" | "saved" | "undoing" | "undone" | "cancelled" | "failed" | "uncertain";
export type MergeJob = {
  id: string; left: string; right: string; primary: string; reviewedPersonIds: string[];
  status: MergeJobStatus; undoRequested: boolean; createdAt: string;
  phase?: "merge" | "undo"; error?: string; notBefore?: number;
};
export const holdsProfiles = (job: MergeJob) => !["cancelled", "undone", "failed"].includes(job.status);
export const isOutstanding = (job: MergeJob) => ["waiting", "queued", "saving", "undoing", "uncertain"].includes(job.status) || (job.status === "saved" && job.undoRequested);
export const MERGE_UNDO_WINDOW_MS = 5000;
type Dependencies = {
  now?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  persist: (jobs: MergeJob[]) => void;
  publish: (jobs: MergeJob[]) => void;
  merge: (job: MergeJob) => Promise<{ id: string; undone?: boolean }>;
  undo: (id: string) => Promise<unknown>;
};

/** Browser outbox: durable IDs make retries safe, while a serial worker preserves undo order. */
export class MergeQueue {
  private jobs: MergeJob[];
  private running = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private now() { return (this.dependencies.now || Date.now)(); }
  constructor(private dependencies: Dependencies, restored: MergeJob[] = []) {
    this.jobs = restored.filter(job => !["waiting", "cancelled", "undone"].includes(job.status)).map(job => ({ ...job,
      status: job.status === "saving" ? "queued" : job.status === "undoing" ? "saved" : job.status,
      undoRequested: job.undoRequested || job.status === "undoing",
    }));
  }
  snapshot() { return this.jobs.map(job => ({ ...job, reviewedPersonIds: [...job.reviewedPersonIds] })); }
  private changed(persist = true) {
    // Keep pending work and the latest 100 completed decisions. Never evict unsent work.
    const finished = this.jobs.filter(job => !isOutstanding(job)).slice(-100);
    const snapshot = this.snapshot();
    if (persist) this.dependencies.persist(snapshot.filter(job => job.status !== "waiting" && (isOutstanding(job) || finished.some(done => done.id === job.id)))); // Must succeed before any request is sent.
    this.dependencies.publish(snapshot);
  }
  start() { this.stopped = false; this.changed(); void this.drain(); }
  stop() {
    this.stopped = true;
    if (this.timer !== null) (this.dependencies.cancel || clearTimeout)(this.timer);
    this.timer = null;
    // Draft confirmations have never become jobs; leaving the page discards them.
    this.jobs = this.jobs.filter(job => job.status !== "waiting");
  }
  private arm() {
    if (this.timer !== null) (this.dependencies.cancel || clearTimeout)(this.timer);
    this.timer = null;
    if (this.stopped || this.running) return;
    const deadlines = this.jobs.filter(job => job.status === "waiting").map(job => job.notBefore!);
    if (!deadlines.length) return;
    this.timer = (this.dependencies.schedule || setTimeout)(() => { this.timer = null; void this.drain(); }, Math.max(0, Math.min(...deadlines) - this.now())) as ReturnType<typeof setTimeout>;
  }
  enqueue(job: Omit<MergeJob, "status" | "undoRequested">) {
    if (this.stopped) throw new Error("The merge queue is paused. Reopen the station to resume.");
    const reserved = new Set(this.jobs.filter(holdsProfiles).flatMap(j => j.reviewedPersonIds));
    if (job.reviewedPersonIds.some(id => reserved.has(id))) return false;
    this.jobs.push({ ...job, status: "waiting", undoRequested: false, notBefore: this.now() + MERGE_UNDO_WINDOW_MS });
    try { this.changed(false); } catch (error) { this.jobs.pop(); throw error; }
    this.arm(); return true;
  }
  undo(id: string) {
    const job = this.jobs.find(job => job.id === id);
    if (!job || ["undone", "cancelled", "failed"].includes(job.status)) return;
    if (job.status === "waiting" || (job.status === "queued" && job.phase !== "merge")) {
      this.jobs = this.jobs.filter(existing => existing.id !== id);
      this.changed(false); this.arm(); return;
    }
    job.undoRequested = true;
    // A lost response may have committed. Recover its receipt before attempting Undo.
    if (job.status === "uncertain") job.status = job.phase === "undo" ? "saved" : "queued";
    job.error = undefined;
    this.changed(); void this.drain();
  }
  retry(id: string) {
    const job = this.jobs.find(job => job.id === id);
    if (!job || job.status !== "uncertain") return;
    job.status = job.phase === "undo" ? "saved" : "queued";
    job.error = undefined;
    this.changed(); void this.drain();
  }
  undoExisting(job: Omit<MergeJob, "status" | "undoRequested">) {
    if (!this.jobs.some(existing => existing.id === job.id)) {
      this.jobs.push({ ...job, status: "saved", undoRequested: false });
    }
    this.undo(job.id);
  }
  private async drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const job = this.jobs.find(job => job.status === "queued" || (job.status === "waiting" && job.notBefore! <= this.now()) || (job.status === "saved" && job.undoRequested));
        if (!job) break;
        try {
          if (job.status === "queued" || job.status === "waiting") {
            job.status = "saving"; job.phase = "merge"; this.changed();
            const result = await this.dependencies.merge({ ...job });
            if (this.stopped) return;
            if (result.id !== job.id) throw new Error("The merge receipt did not match the queued operation.");
            job.status = result.undone ? "undone" : "saved"; this.changed();
          }
          if (job.status === "saved" && job.undoRequested) {
            job.status = "undoing"; job.phase = "undo"; this.changed();
            await this.dependencies.undo(job.id);
            if (this.stopped) return;
            job.status = "undone"; this.changed();
          }
        } catch (error) {
          if (this.stopped) return;
          const status = (error as { status?: number }).status;
          job.error = error instanceof Error ? error.message : "Unable to save this decision.";
          if (status >= 400 && status < 500) {
            // A rejected merge never committed; a rejected Undo leaves the merge intact.
            job.status = job.phase === "undo" ? "saved" : "failed";
            job.undoRequested = false;
          } else job.status = "uncertain";
          try { this.changed(); }
          catch {
            this.stopped = true;
            job.status = "uncertain";
            job.error = "The queue could not be saved in browser storage. Keep this tab open and free browser storage before reloading.";
            this.dependencies.publish(this.snapshot());
          }
        }
      }
    } finally { this.running = false; this.arm(); }
  }
}
