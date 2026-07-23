export function retryAfterMs(value: string | null, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

export function rateLimitBackoffMs({
  retryAfter,
  attempt,
  baseMs = 1_000,
  maxMs = 30_000,
}: {
  retryAfter: string | null;
  attempt: number;
  baseMs?: number;
  maxMs?: number;
}) {
  const requestedDelay = retryAfterMs(retryAfter);
  if (requestedDelay !== null) return Math.min(maxMs, requestedDelay);
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt)));
}
