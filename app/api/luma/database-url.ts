export function databaseUrlWithPoolLimits(
  value: string,
  {
    connectionLimit = 2,
    poolTimeoutSeconds = 20,
    preferSupabaseTransactionPooler = true,
  }: {
    connectionLimit?: number;
    poolTimeoutSeconds?: number;
    preferSupabaseTransactionPooler?: boolean;
  } = {},
) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return value;
    if (preferSupabaseTransactionPooler && isSupabaseSessionPooler(url)) {
      url.port = "6543";
      url.searchParams.set("pgbouncer", "true");
    }
    url.searchParams.set("connection_limit", String(boundedInteger(connectionLimit, 2, 1, 10)));
    url.searchParams.set("pool_timeout", String(boundedInteger(poolTimeoutSeconds, 20, 1, 60)));
    return url.toString();
  } catch {
    return value;
  }
}

function isSupabaseSessionPooler(url: URL) {
  return url.port === "5432" && /(^|\.)pooler\.supabase\.com$/i.test(url.hostname);
}

function boundedInteger(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}
