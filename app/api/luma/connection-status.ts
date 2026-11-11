import { lumaApiKeys, lumaSessionTokens } from "./api-keys";

// One small read per configured session. Never fetch guests or write the index.
export async function lumaConnectionStatus({ environment = process.env, fetchImpl = fetch }: {
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}) {
  const sessions = await Promise.all(lumaSessionTokens(environment).map(async (token) => {
    let status: "connected" | "invalid" | "unavailable" = "unavailable";
    try {
      const response = await fetchImpl("https://api.luma.com/home/get-events?period=future&pagination_limit=1", {
        headers: {
          cookie: `luma.auth-session-key=${encodeURIComponent(token.value)}`,
          "x-luma-client-type": "luma-web",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (response.ok) {
        const payload = await response.json() as { entries?: unknown } | null;
        if (Array.isArray(payload?.entries)) status = "connected";
      } else if ([400, 401, 403].includes(response.status)) {
        status = "invalid";
      }
      await response.body?.cancel().catch(() => {});
    } catch {
      // Do not return upstream errors: they may contain credential information.
    }
    return { name: token.envName, status };
  }));
  return {
    apiKeyCount: lumaApiKeys(environment).length,
    sessions,
    checkedAt: new Date().toISOString(),
  };
}
